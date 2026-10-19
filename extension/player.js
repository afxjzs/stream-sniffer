const form = document.getElementById('form');
const problemsEl = document.getElementById('problems');
const streamsEl = document.getElementById('streams');
const menu = document.getElementById('menu');
const settingsBtn = document.getElementById('settings');
const removeSmallBtn = document.getElementById('remove-small');
const castStatus = document.getElementById('cast-status');
const params = new URLSearchParams(location.search);
const videos = [...document.querySelectorAll('video')];

// The streams on screen, big one first. The page shows at most two (one fills the tab, one
// floats small); background.js gives each stream its own header rule, with no fixed limit.
const MAX_STREAMS = 2;
let streams = [];
let pageError = ''; // a problem that isn't about one stream
const big = () => streams[0];
const streamOf = (video) => streams.find((s) => s.video === video);

const browserCodecs = {
  inflate: (b) => decompress(b, 'deflate'),
  gunzip: (b) => decompress(b, 'gzip'),
};
async function decompress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Each stream's requests can need their own Referer/Origin. The browser only applies them to
// hosts the stream has registered with background.js, so register each host before its first
// request.
async function allowHost(stream, url) {
  const host = new URL(url).hostname;
  if (stream.hosts.has(host)) return;
  const res = await chrome.runtime.sendMessage({ type: 'stream-host', streamId: stream.id, url });
  if (!res?.ok) throw new Error(`Could not set up request headers for ${host}: ${res?.error ?? 'no response from background'}`);
  stream.hosts.add(host);
}

// hls.js loader for every request of one stream: registers the host first (see allowHost), and
// decodes image-disguised segments (see disguise.js) before the demuxer sees them. A segment
// that's an image we can't decode fails loudly with the reason.
function loaderFor(stream) {
  return class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      this.cancelled = false;
      allowHost(stream, context.url).then(
        () => {
          if (!this.cancelled) super.load(context, config, unwrapping(stream, callbacks));
        },
        (err) => {
          fail(stream, err.message);
          callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
        }
      );
    }
    abort() {
      this.cancelled = true;
      super.abort();
    }
  };
}

function unwrapping(stream, callbacks) {
  return {
    ...callbacks,
    onSuccess: (response, stats, ctx, details) => {
      // A "playlist" that isn't one (an HTML error page, an empty body) fails as a load error, so
      // hls.js retries it like any failed request. Playlist problems it skips are another matter
      // (see hlsLogger).
      if (typeof response.data === 'string' && !response.data.trimStart().startsWith('#EXTM3U')) {
        const text = response.data.replace(/\s+/g, ' ').trim();
        const sent = text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : 'an empty body';
        return callbacks.onError({ code: response.code, text: `not a playlist (no #EXTM3U); server sent ${sent}` }, ctx, details, stats);
      }
      const bytes = response.data instanceof ArrayBuffer ? new Uint8Array(response.data) : null;
      if (!bytes || !StreamSnifferDisguise.isPng(bytes)) return callbacks.onSuccess(response, stats, ctx, details);
      StreamSnifferDisguise.decodeDisguisedSegment(bytes, browserCodecs).then(
        (ts) => {
          response.data = ts.buffer.slice(ts.byteOffset, ts.byteOffset + ts.byteLength);
          if (stream.unwrapped++ === 0) {
            stream.status += ' · segments are disguised as images; decoding them';
            render();
          }
          callbacks.onSuccess(response, stats, ctx, details);
        },
        (err) => {
          fail(stream, `Couldn't decode a segment: ${err.message}`);
          callbacks.onError({ code: 0, text: err.message }, ctx, details, stats);
        }
      );
    },
  };
}

// Some live CDNs put a fresh token in segment paths on every playlist refresh. hls.js calls
// that a "media sequence mismatch" and, with one quality level, stops the stream for good, while
// the site's own player carries on. So hls.js skips playlist problems
// (ignorePlaylistParsingErrors), and since it reports what it skipped only as a log warning, its
// warnings come here: each skipped problem is counted in the stream's status, and shown over
// the video if the stream stalls.
const PLAYLIST_PROBLEM = /sequence mismatch|EXTM3U|EXT-X-|Target Duration|no levels found/;
function hlsLogger(stream) {
  const quiet = () => {}; // hls.js's routine chatter, which it doesn't print by default either
  return {
    debug: quiet,
    log: quiet,
    info: quiet,
    warn: (...args) => {
      console.warn('[stream-sniffer] hls.js:', ...args);
      const text = args.map(String).join(' ');
      if (!PLAYLIST_PROBLEM.test(text)) return;
      stream.skipped++;
      // The message goes on to quote both playlists; the first line says what was wrong.
      stream.lastSkipped = `${new Date().toLocaleTimeString()}: ${text.split('\n')[0].slice(0, 200)}`;
      render();
    },
    error: (...args) => console.error('[stream-sniffer] hls.js:', ...args),
  };
}

function fail(stream, msg) {
  console.error('[stream-sniffer]', msg);
  stream.error = msg;
  render();
}

function failPage(msg) {
  console.error('[stream-sniffer]', msg);
  pageError = msg;
  render();
}

// Plays source in slot 0 (big) or 1 (small), replacing whatever was there.
async function startStream(source, slot) {
  const old = streams[slot];
  if (old) await stopStream(old);
  const video = old?.video ?? videos.find((v) => !streamOf(v));
  const stream = {
    id: crypto.randomUUID(),
    source,
    video,
    hls: null,
    hosts: new Set(),
    status: 'Loading…',
    error: '',
    bufferingSince: null,
    lastProblem: '',
    problemKind: null, // 'playlist' or 'segment': a later load of that kind ends lastProblem
    resumes: 0, // pauses undone (see the 'pause' listener)
    lastResume: '',
    resumedAt: 0, // performance.now()
    unwrapped: 0,
    autoMuted: false, // muted by us for the autoplay policy, not by the user
    casting: false,
    skipped: 0, // playlist problems hls.js skipped (see hlsLogger)
    lastSkipped: '',
  };
  streams[slot] = stream;
  pageError = '';
  layout();
  persist();
  if (slot === 0) fillForm();
  render();

  if (!Hls.isSupported()) return fail(stream, 'hls.js is not supported in this browser (no Media Source Extensions).');
  const res = await chrome.runtime.sendMessage({
    type: 'stream-headers',
    streamId: stream.id,
    referer: source.referer,
    origin: source.origin,
  });
  if (!streams.includes(stream)) return; // replaced while we waited
  if (!res?.ok) return fail(stream, `Could not set up request headers: ${res?.error ?? 'no response from background'}`);
  stream.status = `Loading… (${res.mode})`;
  render();

  const hls = (stream.hls = new Hls({
    loader: loaderFor(stream),
    ignorePlaylistParsingErrors: true,
    debug: hlsLogger(stream),
  }));
  hls.on(Hls.Events.ERROR, (_e, data) => {
    const code = data.response?.code;
    const why = data.response?.text ? ` (${data.response.text})` : parseProblem(data);
    const detail = `${data.type} / ${data.details}${why}${code ? ` — HTTP ${code}` : ''}${data.url ? ` — ${data.url}` : ''}${serverSent(data)}`;
    if (data.fatal) {
      stream.status = 'Stopped';
      // Keep a more specific message (e.g. from allowHost) if one is already showing.
      fail(stream, stream.error || `Playback failed: ${detail}`);
    } else {
      // hls.js retries these itself, but a stall with no explanation looks like a frozen
      // picture; show the latest one until playback is healthy again.
      console.warn('[stream-sniffer] non-fatal hls.js error:', detail);
      stream.lastProblem = `${new Date().toLocaleTimeString()}: ${detail} (retrying)`;
      stream.problemKind = /^(frag|key)Load/.test(data.details)
        ? 'segment'
        : /^(manifest|level|audioTrack|subtitleTrack)Load/.test(data.details)
          ? 'playlist'
          : null; // e.g. a stalled buffer: over when the video plays again
      render();
    }
  });
  // A retried load that then works ends the problem it showed.
  const recovered = (kind) => () => {
    if (stream.problemKind !== kind) return;
    stream.lastProblem = '';
    stream.problemKind = null;
    render();
  };
  hls.on(Hls.Events.FRAG_LOADED, recovered('segment'));
  for (const e of [Hls.Events.MANIFEST_LOADED, Hls.Events.LEVEL_LOADED, Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.SUBTITLE_TRACK_LOADED]) {
    hls.on(e, recovered('playlist'));
  }
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    const n = data.levels.length;
    stream.status = `Playing · ${n} quality level${n === 1 ? '' : 's'} · ${res.mode}${stream.unwrapped ? ' · segments are disguised as images; decoding them' : ''}`;
    render();
    startPlayback(stream);
  });
  hls.loadSource(source.url);
  hls.attachMedia(video);
}

// For a playlist hls.js couldn't parse: its reason ("no EXTM3U delimiter", "media sequence
// mismatch"...) and the start of what the server actually sent.
function parseProblem(data) {
  return /ParsingError$/.test(data.details) && data.reason ? ` (${data.reason})` : '';
}
function serverSent(data) {
  if (!/ParsingError$/.test(data.details)) return '';
  const xhr = data.networkDetails;
  // responseText throws for binary responses; playlists are loaded as text.
  if (!(xhr instanceof XMLHttpRequest) || !['', 'text'].includes(xhr.responseType)) return '';
  const text = xhr.responseText.replace(/\s+/g, ' ').trim();
  return ` — server sent ${text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : 'an empty body'}`;
}

async function stopStream(s) {
  s.hls?.destroy();
  s.hls = null;
  s.video.removeAttribute('src');
  s.video.load();
  // The relay bridge still fetches through this stream's header rule while it casts.
  if (bridge?.stream === s && !bridge.stopped) return;
  const res = await chrome.runtime.sendMessage({ type: 'stream-remove', streamId: s.id });
  if (!res?.ok) failPage(`Could not remove the old stream's header rule: ${res?.error ?? 'no response from background'}`);
}

// Autoplay with sound needs a user gesture on this tab; fall back to muted and say so.
// The small picture is always muted: the sound follows the big one.
async function startPlayback(s) {
  const v = s.video;
  v.muted = s !== big();
  try {
    await v.play();
  } catch (err) {
    if (err.name !== 'NotAllowedError') return fail(s, `video.play() failed: ${err.message}`);
    v.muted = true;
    s.autoMuted = true;
    try {
      await v.play();
      s.status += ' · muted (autoplay policy), unmute in the controls';
      render();
    } catch (err2) {
      fail(s, `video.play() failed even muted: ${err2.message}`);
    }
  }
}

// Big and small trade places, and the sound moves to the new big picture. Neither reloads.
function swap() {
  if (streams.length < 2) return;
  const [oldBig, oldSmall] = streams;
  const sound = !oldBig.video.muted || oldBig.autoMuted;
  oldSmall.video.volume = oldBig.video.volume;
  streams = [oldSmall, oldBig];
  layout();
  oldBig.video.muted = true;
  oldSmall.video.muted = !sound;
  oldBig.autoMuted = oldSmall.autoMuted = false;
  for (const s of streams) {
    if (s.hls && s.video.paused) s.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
  }
  persist();
  fillForm();
  render();
}

// Which video element is big, which is small, and which is unused.
function layout() {
  for (const v of videos) {
    const i = streams.findIndex((s) => s.video === v);
    v.classList.toggle('big', i === 0);
    v.classList.toggle('small', i > 0);
    v.controls = i === 0;
    v.hidden = i === -1 || streams[i].casting;
    v.removeAttribute('style'); // the big one fills the tab; the small one is placed below
    if (i > 0) placeSmall(v);
  }
  placeRemoveBtn();
}

// The × sits inside the small picture's top-right, clear of the corner that resizes it.
function placeRemoveBtn() {
  const small = streams[1];
  removeSmallBtn.hidden = !small || small.casting;
  if (removeSmallBtn.hidden) return;
  const r = small.video.getBoundingClientRect();
  Object.assign(removeSmallBtn.style, { left: `${r.right - CORNER - 30}px`, top: `${r.top + 6}px` });
}
removeSmallBtn.addEventListener('click', async () => {
  const s = streams[1];
  if (!s) return;
  streams.splice(1, 1);
  layout();
  persist();
  render();
  await stopStream(s);
});

// The small picture can be dragged anywhere and resized from any corner (keeping its shape and
// the opposite corner). A press that doesn't move is a click, which swaps. Its place and size
// are remembered for every player tab; until it's first moved, the stylesheet places it.
const CORNER = 16; // px from a corner that grabs it for resizing
const MIN_WIDTH = 160;
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag, not a click
let smallBox = null; // { x, y, w } in px
chrome.storage.local
  .get('smallBox')
  .then(({ smallBox: saved }) => {
    if (saved) smallBox = saved;
    layout();
  })
  .catch((err) => failPage(`Couldn't read the small window's saved place: ${err.message}`));

const smallHeight = (w) => (w * 9) / 16;
function clampBox({ x, y, w }) {
  w = Math.max(MIN_WIDTH, Math.min(w, innerWidth - 16));
  const h = smallHeight(w);
  return { x: Math.max(0, Math.min(x, innerWidth - w)), y: Math.max(0, Math.min(y, innerHeight - h)), w };
}
function placeSmall(v) {
  if (!smallBox) return;
  const { x, y, w } = clampBox(smallBox);
  Object.assign(v.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, right: 'auto', bottom: 'auto', maxWidth: 'none' });
}
addEventListener('resize', layout);

// Which corner (if any) a point near the small video's edge grabs: [dx sign, dy sign].
function cornerAt(v, e) {
  const r = v.getBoundingClientRect();
  const left = e.clientX - r.left < CORNER;
  const right = r.right - e.clientX < CORNER;
  const top = e.clientY - r.top < CORNER;
  const bottom = r.bottom - e.clientY < CORNER;
  if ((left || right) && (top || bottom)) return [right ? 1 : -1, bottom ? 1 : -1];
  return null;
}

for (const v of videos) {
  let press = null;
  v.addEventListener('pointerdown', (e) => {
    if (!streamOf(v) || streamOf(v) === big() || e.button !== 0) return;
    const r = v.getBoundingClientRect();
    press = { x0: e.clientX, y0: e.clientY, box: { x: r.left, y: r.top, w: r.width }, corner: cornerAt(v, e), dragging: false };
    v.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  v.addEventListener('pointermove', (e) => {
    if (!press) {
      if (streamOf(v) && streamOf(v) !== big()) {
        const c = cornerAt(v, e);
        v.style.cursor = c ? (c[0] === c[1] ? 'nwse-resize' : 'nesw-resize') : 'grab';
      }
      return;
    }
    const dx = e.clientX - press.x0;
    const dy = e.clientY - press.y0;
    if (!press.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    press.dragging = true;
    const { box, corner } = press;
    if (!corner) {
      smallBox = clampBox({ x: box.x + dx, y: box.y + dy, w: box.w });
    } else {
      const w = Math.max(MIN_WIDTH, Math.min(box.w + corner[0] * dx, innerWidth - 16));
      smallBox = clampBox({
        x: corner[0] < 0 ? box.x + box.w - w : box.x,
        y: corner[1] < 0 ? box.y + smallHeight(box.w) - smallHeight(w) : box.y,
        w,
      });
    }
    placeSmall(v);
    placeRemoveBtn();
  });
  v.addEventListener('pointerup', () => {
    if (!press) return;
    const dragged = press.dragging;
    press = null;
    if (!dragged) return swap();
    chrome.storage.local.set({ smallBox }).catch((err) => failPage(`Couldn't save the small window's place: ${err.message}`));
  });
  v.addEventListener('pointercancel', () => (press = null));
  // Buffering and recent stream problems show over the video so a stall is never silent.
  v.addEventListener('waiting', () => {
    const s = streamOf(v);
    if (!s) return;
    s.bufferingSince ??= new Date().toLocaleTimeString();
    render();
  });
  v.addEventListener('playing', () => {
    const s = streamOf(v);
    if (!s) return;
    s.bufferingSince = null;
    s.lastProblem = '';
    s.problemKind = null;
    render();
  });
  // These are live streams, so they just play: a pause (the controls, the browser) is undone at
  // once and noted in the status. One that comes right back after a resume is reported, not
  // fought in a loop.
  v.addEventListener('pause', () => {
    const s = streamOf(v);
    if (!s?.hls || v.ended) return; // stopped or replaced on purpose, or the end of a video
    const now = performance.now();
    const at = new Date().toLocaleTimeString();
    if (now - s.resumedAt < 1000) {
      return fail(s, `The video keeps pausing (again at ${at}, right after the player resumed it). Press play to try again.`);
    }
    s.resumedAt = now;
    s.resumes++;
    s.lastResume = at;
    render();
    v.play().catch((err) => fail(s, `Couldn't resume after a pause: video.play() failed: ${err.message}`));
  });
  v.addEventListener('enterpictureinpicture', syncPopout);
  v.addEventListener('leavepictureinpicture', syncPopout);
}

// Media keys and Chrome's media controls ask the page to pause through the Media Session API.
// Chrome has also sent this right after a swap, unasked. Live streams just play, so the request
// is ignored, and the ignoring is noted in each stream's status.
let ignoredPauses = 0;
let lastIgnoredPause = '';
navigator.mediaSession.setActionHandler('pause', () => {
  ignoredPauses++;
  lastIgnoredPause = new Date().toLocaleTimeString();
  console.log(`[stream-sniffer] ignored a pause request from Chrome's media controls at ${lastIgnoredPause}`);
  render();
});
navigator.mediaSession.setActionHandler('play', () => {
  for (const s of streams) {
    if (s.hls) s.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
  }
});

function health(s) {
  const parts = [];
  if (s.bufferingSince) parts.push(`Buffering since ${s.bufferingSince}, waiting for video data`);
  if (s.lastProblem) parts.push(`Last problem ${s.lastProblem}`);
  if (s.bufferingSince && s.lastSkipped) parts.push(`Last skipped playlist problem ${s.lastSkipped}`);
  return parts.join(' · ');
}

let renderedEntries = '';
function render() {
  const label = (s) => (streams.length > 1 ? (s === big() ? 'Big: ' : 'Small: ') : '');
  const lines = [];
  if (pageError) lines.push(['error', pageError]);
  for (const s of streams) {
    if (s.error) lines.push(['error', label(s) + s.error]);
    if (health(s)) lines.push(['warn', label(s) + health(s)]);
  }
  problemsEl.replaceChildren(
    ...lines.map(([cls, text]) => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      return p;
    })
  );

  // Rebuilt only when its text changes, so a link isn't swapped out from under a click.
  const entries = streams.map((s, i) => ({
    heading: streams.length > 1 ? (i === 0 ? 'Big screen' : 'Small screen (click it to swap)') : 'Now playing',
    pageUrl: s.source.pageUrl,
    pageTitle: s.source.pageTitle,
    status: [
      s.status,
      s.skipped && `hls.js skipped ${s.skipped} playlist problem${s.skipped === 1 ? '' : 's'} (last ${s.lastSkipped})`,
      s.resumes && `resumed after ${s.resumes} pause${s.resumes === 1 ? '' : 's'} (last ${s.lastResume})`,
      ignoredPauses && `ignored ${ignoredPauses} pause request${ignoredPauses === 1 ? '' : 's'} from Chrome's media controls (last ${lastIgnoredPause})`,
    ]
      .filter(Boolean)
      .join(' · '),
    url: s.source.url,
  }));
  if (JSON.stringify(entries) !== renderedEntries) {
    renderedEntries = JSON.stringify(entries);
    streamsEl.replaceChildren(...entries.map(streamEntry));
  }

  const b = big()?.source;
  document.title = b?.pageUrl ? `▶ ${b.pageTitle || b.pageUrl}` : 'Stream Sniffer Player';
}

// Shows which page a stream came from, its status, and its URL.
function streamEntry(e) {
  const el = document.createElement('div');
  el.className = 'stream';
  const h = document.createElement('h2');
  h.textContent = e.heading;
  el.append(h);
  if (e.pageUrl) {
    const p = document.createElement('p');
    p.className = 'small';
    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = e.pageUrl;
    a.textContent = e.pageTitle ? `${e.pageTitle} (${e.pageUrl})` : e.pageUrl;
    p.append('From ', a);
    el.append(p);
  }
  const status = document.createElement('p');
  status.className = 'muted small';
  status.textContent = e.status;
  const url = document.createElement('code');
  url.textContent = e.url;
  el.append(status, url);
  return el;
}

function openMenu(open) {
  menu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}
settingsBtn.addEventListener('click', () => openMenu(menu.hidden));

// Every stream's source (URL, headers, source page) lives in session storage under cap:<id>,
// and the page URL lists the ids big first, so a reload brings back both pictures. Session
// storage keeps cookies out of the URL and browser history.
async function saveSource(source) {
  const capId = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${capId}`]: source });
  return { ...source, capId };
}

async function loadSource(capId) {
  const { [`cap:${capId}`]: c } = await chrome.storage.session.get(`cap:${capId}`);
  if (!c) throw new Error('This player link has expired (its captured headers are gone). Reopen it from the popup.');
  return { ...c, capId };
}

function persist() {
  history.replaceState(null, '', `?${new URLSearchParams(streams.map((s) => ['cap', s.source.capId]))}`);
}

// Pop the big video out into Chrome's floating picture-in-picture window, or bring it back.
// The label follows the real state, so closing the floating window by hand updates it too.
const popoutBtn = document.getElementById('popout');
function syncPopout() {
  popoutBtn.textContent = document.pictureInPictureElement ? 'Back to tab' : 'Pop out';
}
popoutBtn.addEventListener('click', async () => {
  pageError = '';
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (!big()?.hls) failPage('Start a stream first, then pop it out.');
    else await big().video.requestPictureInPicture();
  } catch (err) {
    failPage(`Couldn't pop out the video: ${err.name}: ${err.message}`);
  }
  render();
});

// The popup's "Add to player" sends this to the player tab used last.
const myTabId = chrome.tabs.getCurrent().then((t) => t.id);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'add-stream') return false;
  myTabId.then(async (id) => {
    if (msg.tabId !== id) return;
    try {
      const source = await loadSource(msg.capId);
      await startStream(source, Math.min(streams.length, MAX_STREAMS - 1));
      sendResponse({ ok: true });
    } catch (err) {
      failPage(err.message);
      sendResponse({ error: err.message });
    }
  });
  return true; // async response; only the addressed tab ever sends one
});

// Cast via the relay. Some stream servers only answer Chrome itself, so this tab does all the
// fetching: it long-polls the relay for URLs the TV wants, fetches them here (where the
// Referer/Origin rewrite applies), and posts the bytes back. The relay serves them to the TV.
// That's why this tab has to stay open while casting. It casts the big picture's stream.
// Where the relay listens. Override with chrome.storage.local.relayUrl (the E2E test uses this
// to run its own relay next to yours); the active address shows in every relay message.
const DEFAULT_RELAY = 'http://localhost:8788';
let RELAY = DEFAULT_RELAY;
const relayReady = chrome.storage.local.get('relayUrl').then(({ relayUrl }) => {
  if (relayUrl) {
    RELAY = relayUrl;
    console.log(`[stream-sniffer] using relay at ${RELAY} (from storage, not the default)`);
  }
});
const relayBtn = document.getElementById('relay');
const setRelay = (msg) => (castStatus.textContent = `Relay: ${msg}`);
let bridge = null;

function startBridge(id, stream) {
  const b = { id, stream, stopped: false, served: 0 };
  b.fail = (msg) => {
    if (b.stopped) return;
    b.stopped = true;
    console.error('[stream-sniffer] bridge stopped:', msg);
    setRelay(`stopped feeding the TV: ${msg}`);
  };
  bridgeLoop(b).catch((err) => b.fail(err.message));
  return b;
}

// One long-poll at a time (Chrome allows only 6 connections to localhost:8788 across all tabs),
// with each job fetched in parallel so playlist refreshes don't wait behind segments.
async function bridgeLoop(b) {
  while (!b.stopped) {
    let res;
    try {
      res = await fetch(`${RELAY}/api/streams/${b.id}/next`, { cache: 'no-store' });
    } catch (err) {
      return b.fail(`lost contact with the relay (${err.message}). Is it still running?`);
    }
    if (b.stopped) return;
    if (res.status === 204) continue; // nothing to fetch during this poll
    if (res.status === 404) return b.fail('the relay no longer knows this stream (did it restart?). Click "Cast via relay" again.');
    if (res.status === 410) return b.fail((await res.json().catch(() => ({}))).error || 'stream retired by the relay');
    if (!res.ok) return b.fail(`relay error HTTP ${res.status}: ${await res.text()}`);
    const job = await res.json();
    runJob(b, job).catch((err) => b.fail(err.message));
  }
}

async function runJob(b, job) {
  let headers;
  let body;
  try {
    await allowHost(b.stream, job.url);
    const up = await fetch(job.url, { cache: 'no-store' });
    body = await up.arrayBuffer();
    headers = {
      'x-upstream-status': String(up.status),
      'x-upstream-type': encodeURIComponent(up.headers.get('content-type') || ''),
      'x-upstream-url': encodeURIComponent(up.url),
    };
  } catch (err) {
    // Reported to the relay, which shows it on the cast page and fails the TV's request.
    body = '';
    headers = { 'x-upstream-error': encodeURIComponent(err.message) };
  }
  let posted;
  try {
    posted = await fetch(`${RELAY}/api/streams/${b.id}/result/${job.id}`, { method: 'POST', headers, body });
  } catch (err) {
    return b.fail(`lost contact with the relay (${err.message}). Is it still running?`);
  }
  // 410 means the TV gave up waiting for this one; not fatal.
  if (!posted.ok && posted.status !== 410) return b.fail(`relay rejected a result: HTTP ${posted.status}`);
  b.served++;
  if (bridge === b && b.info && !b.stopped) setRelay(`feeding the TV — keep this tab open. ${b.served} requests fetched for it.`);
}

relayBtn.addEventListener('click', async () => {
  const s = big();
  if (!s) {
    setRelay('play a stream first.');
    return;
  }
  await relayReady;
  setRelay(`registering stream with the relay at ${RELAY}…`);
  let res;
  try {
    res = await fetch(`${RELAY}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: s.source.url }),
    });
  } catch (err) {
    console.error('[stream-sniffer] relay unreachable', err);
    setRelay(`not running at ${RELAY}. Start it in a terminal from the stream-sniffer folder: node relay/server.mjs`);
    return;
  }
  const reg = await res.json().catch((err) => ({ error: `relay sent a non-JSON reply (HTTP ${res.status}): ${err.message}` }));
  if (!res.ok || reg.error) {
    setRelay(reg.error || `HTTP ${res.status}`);
    return;
  }

  if (bridge) bridge.stopped = true;
  const b = (bridge = startBridge(reg.id, s));
  setRelay('checking the stream through this tab…');
  const probeRes = await fetch(`${RELAY}/api/streams/${reg.id}/probe`, { method: 'POST' });
  const info = await probeRes.json().catch((err) => ({ error: `relay sent a non-JSON reply (HTTP ${probeRes.status}): ${err.message}` }));
  if (!probeRes.ok || info.error) {
    b.stopped = true;
    setRelay(info.error || `HTTP ${probeRes.status}`);
    return;
  }
  b.info = info;

  // The TV takes over; stop playing here so the stream isn't downloaded twice.
  if (s.hls) {
    s.hls.destroy();
    s.hls = null;
    s.video.removeAttribute('src');
    s.video.load();
    s.casting = true; // an empty player box while the TV plays is just dead space
    layout();
    s.status = 'Stopped here while casting. Press Play to watch on this computer again.';
    render();
  }
  const frame = document.getElementById('cast-frame');
  frame.src = `${info.castPageUrl}?embed=1`;
  frame.hidden = false;
  frame.style.height = '300px'; // until the cast page reports its real height
  setRelay('ready — click "Cast to TV" below. Keep this tab open; it fetches the stream for the TV.');
});

// The cast page reports its content height; grow the frame to match so it never scrolls.
window.addEventListener('message', (e) => {
  if (e.origin !== new URL(RELAY).origin || e.data?.type !== 'cast-frame-height') return;
  document.getElementById('cast-frame').style.height = `${Math.ceil(e.data.height)}px`;
});

function readForm() {
  const f = new FormData(form);
  return {
    url: f.get('url').trim(),
    referer: f.get('referer').trim(),
    origin: f.get('origin').trim(),
  };
}

function fillForm() {
  const s = big()?.source;
  for (const name of ['url', 'referer', 'origin']) form.elements[name].value = s?.[name] || '';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSource(readForm())
    .then((source) => startStream(source, 0))
    .catch((err) => failPage(err.message));
});

// Bring back the streams listed in the URL (?cap=<id>, big first), or play a plain
// ?url=&referer=&origin= link. With nothing to play, open the menu at the form.
async function init() {
  const reset = await chrome.runtime.sendMessage({ type: 'player-reset' });
  if (!reset?.ok) throw new Error(`Could not clear this tab's old header rules: ${reset?.error ?? 'no response from background'}`);
  const sources = [];
  for (const id of params.getAll('cap').slice(0, MAX_STREAMS)) sources.push(await loadSource(id));
  if (!sources.length && params.get('url')) {
    sources.push(await saveSource({ url: params.get('url'), referer: params.get('referer') || '', origin: params.get('origin') || '' }));
  }
  if (!sources.length) return openMenu(true);
  for (const [i, source] of sources.entries()) await startStream(source, i);
}
init().catch((err) => {
  openMenu(true);
  failPage(err.message);
});
