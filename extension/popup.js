const VLC = '/Applications/VLC.app/Contents/MacOS/VLC';
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');

// Single quotes stop the shell from touching $, &, ? etc. in tokenized URLs.
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function vlcCommand(c) {
  const parts = [VLC];
  if (c.referer) parts.push(`--http-referrer=${sq(c.referer)}`);
  if (c.userAgent) parts.push(`--http-user-agent=${sq(c.userAgent)}`);
  parts.push(sq(c.url));
  return parts.join(' ');
}

// Headers curl sets itself or that would change the response shape (compressed body).
const CURL_SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

function curlCommand(c) {
  const parts = ['curl -sS'];
  for (const [name, value] of Object.entries(c.headers || {})) {
    if (!CURL_SKIP.has(name)) parts.push(`-H ${sq(`${name}: ${value}`)}`);
  }
  parts.push(sq(c.url));
  return parts.join(' ');
}

// The full header set (cookies included) goes to the player through session storage
// rather than the URL, so it doesn't land in browser history.
async function openPlayer(c) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${id}`]: c });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?cap=${id}`) });
}

// Adds the stream to the player tab used last, as its small picture (or as its only one if
// it has none). With no player tab open, opens one.
async function addToPlayer(c) {
  const playerUrl = chrome.runtime.getURL('player.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const tabIds = contexts.filter((x) => x.documentUrl.startsWith(playerUrl)).map((x) => x.tabId);
  if (!tabIds.length) return openPlayer(c);
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  if (tabs.some((t) => t.lastAccessed == null)) throw new Error("this Chrome doesn't say which player tab was used last");
  const target = tabs.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${id}`]: c });
  const res = await chrome.runtime.sendMessage({ type: 'add-stream', tabId: target.id, capId: id });
  if (!res?.ok) throw new Error(res?.error ?? 'the player tab did not answer');
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
}

// --- What a stream offers, before opening it ---
// The popup fetches each playlist the way the page did (same Referer/Origin, through a header
// rule of its own; see background.js) and reports what it says. A playlist listing qualities
// says their resolution, often frame rate, and an advertised bitrate; a playlist of a single
// quality says none of that, so "Check quality" plays it unseen for a few seconds to measure.
const { allowHost, makeLoader, fetchFromPage, isWeb, snapFps, bestLevel, rateText, codecName } = StreamSnifferShared;

async function withHeaders(c, fn) {
  const streamId = crypto.randomUUID();
  const res = await chrome.runtime.sendMessage({ type: 'stream-headers', streamId, referer: c.referer, origin: c.origin });
  if (!res?.ok) throw new Error(`Could not set up request headers: ${res?.error ?? 'no response from background'}`);
  try {
    return await fn(streamId, new Set());
  } finally {
    await chrome.runtime.sendMessage({ type: 'stream-remove', streamId });
  }
}

async function fetchPlaylist(c, streamId, hosts, url) {
  if (c.viaPage && !isWeb(url)) return fetchFromPage(c.viaPage, url);
  await allowHost(streamId, hosts, url);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('not a playlist (no #EXTM3U)');
  return text;
}

// Attribute lists like BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
function attrs(list) {
  return Object.fromEntries([...list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]));
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  lines.forEach((line, i) => {
    const m = line.match(/^#EXT-X-STREAM-INF:(.*)$/);
    if (!m) return;
    const a = attrs(m[1]);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    variants.push({
      height: a.RESOLUTION ? Number(a.RESOLUTION.split('x')[1]) : 0,
      fps: Number(a['FRAME-RATE']) || 0,
      bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
      codecs: a.CODECS || '',
      url: uri && new URL(uri.trim(), baseUrl).href,
    });
  });
  return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), live: !/^#EXT-X-ENDLIST/m.test(text) };
}

const quality = (height, fps) => (height ? `${height}p${fps ? snapFps(fps) : ''}` : 'resolution not listed');

// e.g. "3 qualities, best 1080p60 · 6.0 Mbps advertised · H.264 · live"
async function describe(c) {
  return withHeaders(c, async (streamId, hosts) => {
    const { variants, live: mediaLive } = parsePlaylist(await fetchPlaylist(c, streamId, hosts, c.url), c.url);
    if (!variants.length) {
      return `${mediaLive ? 'Live' : 'Not live'} · a single quality; its playlist doesn't list resolution or bitrate. Check quality measures them.`;
    }
    const best = variants[0];
    // Whether it's live is in the quality playlists, not this list; the best one's says.
    const live = best.url ? parsePlaylist(await fetchPlaylist(c, streamId, hosts, best.url), best.url).live : null;
    const n = variants.length;
    return [
      n === 1 ? `1 quality: ${quality(best.height, best.fps)}` : `${n} qualities, best ${quality(best.height, best.fps)}`,
      best.bandwidth && `${rateText(best.bandwidth / 1e6)} advertised`,
      codecName(best.codecs),
      live == null ? '' : live ? 'live' : 'not live',
    ]
      .filter(Boolean)
      .join(' · ');
  });
}

// Plays the stream's best quality muted, in a small preview, until resolution, frame rate and
// a segment's bitrate are known (or 20 s pass). e.g. "Checked: 1080p60 · 6.2 Mbps measured"
const CHECK_TIMEOUT_MS = 20000;

// hls.js is 600 KB and only a check needs it, so the popup doesn't load it until then.
let hlsLoaded = null;
function loadHls() {
  hlsLoaded ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/hls.min.js';
    script.onload = resolve;
    script.onerror = () => {
      hlsLoaded = null;
      reject(new Error("couldn't load vendor/hls.min.js"));
    };
    document.head.append(script);
  });
  return hlsLoaded;
}

async function checkQuality(c, previewEl) {
  await loadHls();
  return withHeaders(
    c,
    (streamId, hosts) =>
      new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        previewEl.replaceChildren(video);
        previewEl.hidden = false;
        const got = { height: 0, fps: 0, bytes: 0, seconds: 0, level: -1 };
        let problem = '';
        let finished = false;
        const hls = new Hls({
          loader: makeLoader({
            allowHost: (url) => allowHost(streamId, hosts, url),
            onDisguised: () => {},
            onFail: (msg) => (problem = msg),
            viaPage: c.viaPage,
          }),
          maxBufferLength: 10,
        });
        const done = (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          hls.destroy();
          previewEl.hidden = true;
          previewEl.replaceChildren();
          const parts = [got.height && quality(got.height, got.fps), got.seconds && `${rateText((got.bytes * 8) / got.seconds / 1e6)} measured`].filter(Boolean);
          if (parts.length) resolve(`Checked: ${parts.join(' · ')}${err ? ` (stopped early: ${err})` : ''}`);
          else reject(new Error(err || 'nothing played'));
        };
        const timer = setTimeout(() => done(problem || 'timed out'), CHECK_TIMEOUT_MS);
        const maybeDone = () => got.height && got.fps && got.seconds && done();

        hls.on(Hls.Events.MANIFEST_PARSED, (_e, { levels }) => {
          got.level = bestLevel(levels);
          hls.currentLevel = got.level; // the best one, held there
          video.play().catch((err) => done(`video.play() failed: ${err.message}`));
        });
        hls.on(Hls.Events.FRAG_LOADED, (_e, { frag, payload }) => {
          if (frag.type !== 'main' || frag.level !== got.level || !(frag.duration > 0)) return;
          got.bytes += payload?.byteLength || frag.stats.total;
          got.seconds += frag.duration;
          maybeDone();
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) done(problem || `${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`);
        });
        video.addEventListener('resize', () => {
          got.height = video.videoHeight;
          maybeDone();
        });
        // Frames shown per second of video, over 2 s of it (as in the player's bar).
        let from = null;
        const tick = (_now, meta) => {
          if (!from) from = meta;
          else if (meta.mediaTime - from.mediaTime >= 2) {
            got.fps = (meta.presentedFrames - from.presentedFrames) / (meta.mediaTime - from.mediaTime);
            return maybeDone();
          }
          if (hls.media) video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
        hls.loadSource(c.url);
        hls.attachMedia(video);
      })
  );
}

// Playlist reads and quality checks run one at a time. The popup's header rules can't tell two
// of its own requests apart (see background.js), so two at once to the same server with
// different headers would clash; and a page with many playlists doesn't fire them all at once.
let popupQueue = Promise.resolve();
function queued(fn) {
  const p = popupQueue.then(fn);
  popupQueue = p.catch(() => {});
  return p;
}

function button(label, onClick, className = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

// "host · last/two" is enough to tell a page's playlists apart; the full URL is under ⋯.
function shortName(url) {
  const u = new URL(url);
  return `${u.host} · ${u.pathname.split('/').filter(Boolean).slice(-2).join('/')}`;
}

function showError(what, err) {
  console.error(`[stream-sniffer] ${what} failed`, err);
  statusEl.textContent = `Error ${what}: ${err.message}`;
  statusEl.className = 'error';
}

async function copy(btn, text) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch (err) {
    console.error('[stream-sniffer] clipboard write failed', err);
    btn.textContent = `Copy failed: ${err.message}`;
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

// Streams are only ever appended (a refreshed URL keeps its slot), so new ones are added to the
// end and existing entries are left alone; rebuilding them would swap buttons out from under a
// click. Buttons read the latest capture for their slot when clicked.
let current = [];

function render(captures) {
  current = captures;
  if (captures.length < listEl.children.length) listEl.replaceChildren(); // tab navigated: list reset
  if (!captures.length) {
    statusEl.textContent = 'No streams seen on this tab yet. Start playback on the page; this list updates live.';
    return;
  }
  if (statusEl.className !== 'error') statusEl.textContent = '';
  for (let i = listEl.children.length; i < captures.length; i++) listEl.append(streamItem(i));
}

// Each stream: its short name and the two buttons used nearly every time. ⋯ shows the full URL,
// the headers, and the copy buttons.
function streamItem(i) {
  const c = current[i];
  const latest = () => current[i];
  const li = document.createElement('li');

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = c.viaVideo ? `Video playing in ${c.viaVideo.host}` : shortName(c.url);
  name.title = c.viaVideo ? `${c.viaVideo.host}, ${c.mime}` : c.url;

  const more = document.createElement('div');
  more.className = 'more';
  more.hidden = true;
  const url = document.createElement('code');
  url.textContent = c.url;
  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = c.referer ? `Referer: ${c.referer}` : 'No Referer was sent';
  if (c.origin) meta.textContent += ` · Origin: ${c.origin}`;
  if (c.viaServiceWorker) meta.textContent += " · fetched by the page's service worker";
  const copies = document.createElement('div');
  copies.className = 'actions';
  if (!c.viaVideo) copies.append(button('Copy URL', (e) => copy(e.currentTarget, latest().url)));
  // A playlist made by its page, or a copy of its video, has no address VLC or curl could fetch.
  if (!c.viaPage && !c.viaVideo) {
    copies.append(
      button('Copy VLC command', (e) => copy(e.currentTarget, vlcCommand(latest()))),
      button('Copy curl command', (e) => copy(e.currentTarget, curlCommand(latest())))
    );
  }
  // Said up front, not under ⋯: it decides whether the user can close the game page.
  const pageNote = document.createElement('div');
  pageNote.className = 'muted small';
  pageNote.hidden = !c.viaPage && !c.viaVideo;
  pageNote.textContent = c.viaVideo
    ? "A live copy of the video this page's player shows, for sites whose stream can't be seen otherwise. Keep its page open and playing; its sound is turned down there while it's copied."
    : "Its playlist is made by the page's own player, not fetched from a server: keep its page open while it plays.";
  more.append(url, meta, copies);

  // What the playlist says it offers, read when the item appears.
  const info = document.createElement('div');
  info.className = 'quality small';
  info.textContent = c.viaVideo ? `Format: ${c.mime}` : 'Reading the playlist…';
  if (!c.viaVideo) queued(() => describe(latest())).then(
    (text) => (info.textContent = text),
    (err) => {
      info.textContent = `Couldn't read the playlist: ${err.message}`;
      info.classList.add('error');
    }
  );
  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.hidden = true;
  const checked = document.createElement('div');
  checked.className = 'quality small';
  checked.hidden = true;

  const moreBtn = button('⋯', () => {
    more.hidden = !more.hidden;
    moreBtn.setAttribute('aria-expanded', String(!more.hidden));
  }, 'icon');
  moreBtn.setAttribute('aria-label', 'More');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.title = 'Full URL, headers, and copy buttons';

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Add to player', () => addToPlayer(latest()).catch((err) => showError('adding to player', err)), 'primary'),
    button('Open in player', () => openPlayer(latest()).catch((err) => showError('opening player', err)), 'primary'),
    c.viaVideo ? '' : button('Check quality', (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      checked.hidden = false;
      checked.classList.remove('error');
      checked.textContent = 'Checking: playing it unseen for a few seconds…';
      queued(() => checkQuality(latest(), preview))
        .then(
          (text) => (checked.textContent = text),
          (err) => {
            checked.textContent = `Couldn't check: ${err.message}`;
            checked.classList.add('error');
          }
        )
        .finally(() => (btn.disabled = false));
    }),
    moreBtn
  );

  li.append(name, info, pageNote, actions, preview, checked, more);
  return li;
}

// "Reopen last player": the streams the player showed last (see persist in player.js), if their
// saved sources are still there (they last until Chrome quits or the extension reloads).
async function showReopen() {
  const { lastSession = [] } = await chrome.storage.session.get('lastSession');
  if (!lastSession.length) return;
  const keys = lastSession.map((id) => `cap:${id}`);
  const found = await chrome.storage.session.get(keys);
  if (keys.some((k) => !found[k])) return;
  const btn = document.getElementById('reopen');
  const n = lastSession.length;
  btn.title = `Open a player with the ${n === 1 ? 'stream' : `${n} streams`} it showed last`;
  btn.hidden = false;
  btn.addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?${new URLSearchParams(lastSession.map((id) => ['cap', id]))}`) })
  );
}

async function main() {
  document.getElementById('manual').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('player.html') })
  );
  showReopen().catch((err) => showError('checking the last player session', err));
  // The background drops the popup's header rules when this connection closes, i.e. when the
  // popup does, even mid-check. Any an earlier popup left (a background restart) go now.
  chrome.runtime.connect({ name: 'popup' });
  await chrome.runtime.sendMessage({ type: 'player-reset' });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Could not find the active tab');
  const k = `tab:${tab.id}`;
  // Listen first, then read: a stream captured between the two would otherwise not show until
  // the popup is reopened.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[k]) render(changes[k].newValue || []);
  });
  const { [k]: captures = [] } = await chrome.storage.session.get(k);
  render(captures);
}

main().catch((err) => {
  console.error('[stream-sniffer] popup failed', err);
  statusEl.textContent = `Error: ${err.message}`;
  statusEl.className = 'error';
});
