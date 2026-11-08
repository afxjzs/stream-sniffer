const form = document.getElementById('form');
const problemsEl = document.getElementById('problems');
const streamsEl = document.getElementById('streams');
const menu = document.getElementById('menu');
const settingsBtn = document.getElementById('settings');
const removeSmallBtn = document.getElementById('remove-small');
const hideSmallBtn = document.getElementById('hide-small');
const showSmallBtn = document.getElementById('show-small');
const castStatus = document.getElementById('cast-status');
const resolutionEl = document.getElementById('resolution');
const bitrateEl = document.getElementById('bitrate');
const params = new URLSearchParams(location.search);
const videos = [...document.querySelectorAll('video')];

// The streams on screen, big one first. The page shows at most two (one fills the tab, one
// floats small); background.js gives each stream its own header rule, with no fixed limit.
const MAX_STREAMS = 2;
let streams = [];
let pageError = ''; // a problem that isn't about one stream
const big = () => streams[0];
const streamOf = (video) => streams.find((s) => s.video === video);

const { makeLoader, snapTo, snapFps, bestLevel, rateText, codecName, COMMON_FPS } = StreamSnifferShared;

// Registers a host for this stream's Referer/Origin before its first request there (see shared.js).
const allowHost = (stream, url) => StreamSnifferShared.allowHost(stream.id, stream.hosts, url);

function loaderFor(stream) {
  return makeLoader({
    allowHost: (url) => allowHost(stream, url),
    onDisguised: () => {
      if (stream.unwrapped++ === 0) render(); // noted in the stream's details
    },
    onFail: (msg) => {
      stream.loadError = msg; // says more than hls.js's error that follows (see the ERROR handler)
      fail(stream, msg);
    },
  });
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
      logEvent(stream, `playlist problem skipped: ${text.split('\n')[0].slice(0, 200)}`);
      render();
    },
    error: (...args) => console.error('[stream-sniffer] hls.js:', ...args),
  };
}

// msg goes in the stream's details in the menu; short (if different) goes over the video.
function fail(stream, msg, short = msg) {
  console.error('[stream-sniffer]', msg);
  logEvent(stream, msg);
  stream.error = msg;
  stream.errorShort = short;
  stream.errorIsPause = false; // set by the caller when the error only says it keeps pausing
  render();
}

function failPage(msg) {
  console.error('[stream-sniffer]', msg);
  logEvent(null, msg);
  pageError = msg;
  render();
}

// The freeze log (⚙ → Copy log): what happened to the streams (freezes, stalls, errors, retries),
// each with what the stream was doing at that moment, so a freeze can be looked at after the
// fact. Every entry is its own storage key, so two player tabs logging at once can't overwrite
// each other, and a reload keeps them. Past LOG_MAX, the oldest go when a player opens.
const LOG_PREFIX = 'log:';
const LOG_MAX = 500;
const tabTag = crypto.randomUUID().slice(0, 4); // tells apart entries from different player tabs
let logSeq = 0;
let logBroken = ''; // why an entry couldn't be saved; Copy log says so
const logStatus = document.getElementById('log-status');

// Which stream: its place on screen and its link without the query (which may hold a token).
function streamLabel(s) {
  const i = streams.indexOf(s);
  const place = i === 0 ? 'big' : i > 0 ? 'small' : 'gone';
  let where = s.source?.url ?? '?';
  try {
    const u = new URL(where);
    where = u.host + u.pathname;
  } catch {
    // Not a URL: shown as it is.
  }
  return `${place} ${where}`;
}

// What a stream is doing: how much video is buffered past what's on screen, and when new video
// last arrived. A source that stopped adding segments looks different here from a player that
// stopped using the ones it has.
function streamState(s) {
  const v = s.video;
  const now = performance.now();
  let ahead = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
  }
  const ago = (t) => (t ? `${((now - t) / 1000).toFixed(1)} s ago` : 'not yet');
  return [
    `${ahead.toFixed(1)} s buffered ahead`,
    `video at ${v.currentTime.toFixed(1)} s${v.paused ? ' (paused)' : ''}`,
    `newest segment in the playlist appeared ${ago(s.edgeAt)}`,
    `last segment downloaded ${ago(s.fragAt)}`,
    `playlist last loaded ${ago(s.playlistAt)}`,
    s.fps ? `${s.fps} fps` : '',
    `status: ${s.status}`,
  ].filter(Boolean).join('; ');
}

function logEvent(s, text) {
  const at = Date.now();
  const entry = { at, tab: tabTag, who: s ? streamLabel(s) : 'player', text, state: s?.video ? streamState(s) : '' };
  const key = `${LOG_PREFIX}${String(at).padStart(15, '0')}:${tabTag}:${String(logSeq++).padStart(6, '0')}`;
  chrome.storage.local.set({ [key]: entry }).catch((err) => {
    // Not failPage: that logs too, and would go round again.
    console.error("[stream-sniffer] couldn't save to the freeze log:", err);
    logBroken = err.message;
  });
}

const allLogKeys = async () => {
  const all = await chrome.storage.local.get(null);
  return [Object.keys(all).filter((k) => k.startsWith(LOG_PREFIX)).sort(), all];
};
allLogKeys()
  .then(([keys]) => keys.length > LOG_MAX && chrome.storage.local.remove(keys.slice(0, keys.length - LOG_MAX)))
  .catch((err) => {
    console.error("[stream-sniffer] couldn't trim the freeze log:", err);
    logBroken = `trimming it failed: ${err.message}`;
  });
logEvent(null, `player opened${location.search ? ` (${location.search.slice(0, 80)})` : ''}`);

function logLine(e) {
  const d = new Date(e.at);
  const time = `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return `${time} [tab ${e.tab}] [${e.who}] ${e.text}${e.state ? ` | ${e.state}` : ''}`;
}
document.getElementById('copy-log').addEventListener('click', async () => {
  try {
    const [keys, all] = await allLogKeys();
    const text = [
      `Stream Sniffer freeze log, copied ${new Date().toString()}`,
      `Extension ${chrome.runtime.getManifest().version}; ${navigator.userAgent}`,
      logBroken && `Warning: some entries couldn't be saved (${logBroken}).`,
      `${keys.length} entries, oldest first:`,
      ...keys.map((k) => logLine(all[k])),
    ].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(text);
    logStatus.textContent = `Copied ${keys.length} log entries. Paste them into chat or a bug report.`;
  } catch (err) {
    console.error("[stream-sniffer] couldn't copy the freeze log:", err);
    logStatus.textContent = `Couldn't copy the log: ${err.message}`;
  }
});

// A frozen picture doesn't always come with an error or a "waiting" event, so every second each
// playing stream's video time is checked; stuck for FROZEN_AFTER_S is logged, and so is the end.
const FROZEN_AFTER_S = 3;
setInterval(() => {
  const now = performance.now();
  for (const s of streams) {
    const t = s.video.currentTime;
    if (!s.hls || s.stopped || s.video.paused || t !== s.lastTime) {
      if (s.frozenLogged) {
        const why = t !== s.lastTime ? 'picture moving again' : s.video.paused ? 'freeze over: the video is paused' : 'freeze over: the stream stopped';
        logEvent(s, `${why} after ${((now - s.stuckSince) / 1000).toFixed(1)} s frozen`);
      }
      s.stuckSince = null;
      s.frozenLogged = false;
      s.lastTime = t;
      continue;
    }
    s.stuckSince ??= now - 1000; // it was last seen moving a second ago
    if (!s.frozenLogged && now - s.stuckSince >= FROZEN_AFTER_S * 1000) {
      s.frozenLogged = true;
      logEvent(s, `picture frozen: the video has been stuck at ${t.toFixed(1)} s for ${FROZEN_AFTER_S} s`);
    }
  }
}, 1000);

// A stream that stops (the server didn't answer, timed out or had an error; the video couldn't
// be decoded) is tried again by itself after these waits; one that plays again starts the count
// over. A refused link (4xx) isn't: it has most likely expired, and only its page has a fresh one.
const RETRY_DELAYS_S = [5, 15, 30];

// Plays source in slot 0 (big) or 1 (small), replacing whatever was there. When it's a retry:
// retries counts the automatic tries so far (see RETRY_DELAYS_S), lastReason says why the last
// one stopped, manual is a press of Retry, and pick is the quality picked by hand before it
// ({ bitrate, height }), kept if the stream still offers it.
async function startStream(source, slot, { retries = 0, lastReason = '', manual = false, pick = null } = {}) {
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
    errorShort: '',
    mode: '', // how its headers are sent, from background.js
    levels: 0,
    bufferingSince: null,
    lastProblem: '',
    lastProblemShort: '',
    problemKind: null, // 'playlist' or 'segment': a later load of that kind ends lastProblem
    resumes: 0, // pauses undone (see the 'pause' listener)
    lastResume: '',
    resumedAt: 0, // performance.now()
    unwrapped: 0,
    autoMuted: false, // muted by us for the autoplay policy, not by the user
    casting: false,
    skipped: 0, // playlist problems hls.js skipped (see hlsLogger)
    lastSkipped: '',
    playingLevel: -1, // index into hls.levels of the picture on screen; -1 until the first one
    rates: [], // the last few video segments' { level, bytes, duration }, for measuredMbps
    fps: 0, // frames shown per second of video, counted as they're shown (see the frame counter)
    quality: -1, // the quality picked in the menu: an index into hls.levels, or -1 for Auto
    stopped: false, // hls.js gave up (a fatal error); Retry starts it again
    loadError: '', // a problem the loader reported (see loaderFor)
    restarting: false, // a retry of this stream has begun (see retry)
    retries,
    retryTimer: null, // the countdown to the next automatic try
    mediaRecoveredAt: -Infinity, // performance.now() of the last decoder recovery (see the ERROR handler)
    // Shown while a retry connects, until the picture is back.
    retrying: retries > 0 || manual,
    retryNote: manual
      ? 'Retrying: connecting…'
      : `Retry ${retries} of ${RETRY_DELAYS_S.length}: connecting… (it stopped because ${lastReason})`,
    recovered: '', // e.g. "back after 2 automatic retries (2:31:05 PM)"
    recoveredUntil: 0, // Date.now() until which that shows over the video
    firstLevel: null, // the quality of the first segment loaded (see the start level)
    // Frame drops (see watchFrames): recent { at, dropped, missing }, totals, and the counts
    // the checks compare against.
    frameEvents: [],
    droppedTotal: 0,
    missingTotal: 0,
    droppedSeen: null, // the video's dropped-frame count at the last check
    gapFrames: 0, // frames skipped in the video's timeline since the last check (see countFrames)
    uneven: 0, // share of frames off the stream's beat (uneven timestamps; see countFrames)
    codec: '', // e.g. "avc1.640028", once the first segment says
    hardware: null, // whether the browser can decode it in hardware (see checkHardware)
    // For the freeze log (performance.now() times; 0 = not yet): see streamState.
    fragAt: 0, // a video segment last downloaded
    playlistAt: 0, // the playlist last loaded
    edgeAt: 0, // the playlist last offered a segment it hadn't before
    edgeSN: -1,
    lastTime: -1, // the video's time at the last freeze check, and whether a freeze is logged
    stuckSince: null,
    frozenLogged: false,
  };
  streams[slot] = stream;
  logEvent(stream, `${manual ? 'Retry pressed' : retries ? `automatic retry ${retries}` : 'started'}${slot ? ' (small picture)' : ''}`);
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
  stream.mode = res.mode;
  render();

  const hls = (stream.hls = new Hls({
    loader: loaderFor(stream),
    ignorePlaylistParsingErrors: true,
    debug: hlsLogger(stream),
    // hls.js keeps everything already played by default. Over a game of several hours that fills
    // the browser's media memory until it has to evict mid-playback, which can hitch. Live
    // streams are never rewound that far, so keep a minute.
    backBufferLength: 60,
    // Assume a good connection (10 Mbps) until the first downloads measure the real one, so the
    // automatic quality doesn't start out cautious. See also the start level, set on
    // MANIFEST_PARSED.
    abrEwmaDefaultEstimate: 10e6,
  }));
  hls.on(Hls.Events.ERROR, (_e, data) => {
    const code = data.response?.code;
    const why = data.response?.text ? ` (${data.response.text})` : parseProblem(data);
    const detail = `${data.type} / ${data.details}${why}${code ? ` — HTTP ${code}` : ''}${data.url ? ` — ${data.url}` : ''}${serverSent(data)}`;
    // A decoding hiccup (a corrupt segment, a decoder reset) is fixed by hls.js itself: it resets
    // the decoder and goes on from the same spot, without reloading. At most once in 30 s; a
    // second one soon after stops the stream, and the automatic retries take over.
    if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR && performance.now() - stream.mediaRecoveredAt > 30000) {
      stream.mediaRecoveredAt = performance.now();
      console.warn('[stream-sniffer] fatal media error, recovering:', detail);
      stream.lastProblem = `${new Date().toLocaleTimeString()}: the video decoder hit a problem (${data.details}); recovering`;
      stream.lastProblemShort = 'The video decoder hit a problem; recovering…';
      logEvent(stream, `decoder problem, recovering in place: ${detail}`);
      stream.problemKind = null; // over when the video plays again
      render();
      hls.recoverMediaError();
      return;
    }
    if (data.fatal) {
      stream.status = 'Stopped';
      stream.lastProblem = stream.lastProblemShort = ''; // hls.js isn't retrying it any more
      stream.stopped = true;
      // A loader problem (a host whose headers couldn't be set, a disguised segment that
      // couldn't be decoded) says more than hls.js does. Any other message already showing is
      // older and unrelated, and mustn't stop the retries.
      const reason = stream.loadError || stopReason(data, code);
      const refused = code >= 400 && code < 500;
      if (!refused && stream.retries < RETRY_DELAYS_S.length) {
        return scheduleRetry(stream, reason, detail);
      }
      const n = stream.retries;
      const after = n ? ` after ${n} automatic ${n === 1 ? 'retry' : 'retries'}` : '';
      const short = refused
        ? `Stopped: ${reason}, so the link has probably expired. Reopen the stream from its page, or press Retry.`
        : `Stopped${after}: ${reason}. Press Retry to try again.`;
      fail(stream, `${short} (${detail})`, short);
    } else {
      // hls.js retries these itself, but a stall with no explanation looks like a frozen
      // picture; show the latest one until playback is healthy again.
      console.warn('[stream-sniffer] non-fatal hls.js error:', detail);
      logEvent(stream, `problem, hls.js retrying it: ${detail}`);
      stream.lastProblem = `${new Date().toLocaleTimeString()}: ${detail} (retrying)`;
      // A stalled buffer already shows as "Buffering…"; failed loads say what's being retried.
      stream.lastProblemShort = data.type === Hls.ErrorTypes.NETWORK_ERROR ? `Reconnecting… (${shortReason(data)})` : '';
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
    stream.lastProblem = stream.lastProblemShort = '';
    stream.problemKind = null;
    render();
  };
  hls.on(Hls.Events.FRAG_LOADED, recovered('segment'));
  // The bitrate a stream really delivers: each video segment's size over its length. A playlist's
  // own figure is only a claim, and a playlist linked directly has none.
  hls.on(Hls.Events.FRAG_LOADED, (_e, { frag, payload }) => {
    if (frag.type !== 'main' || !(frag.duration > 0)) return;
    stream.fragAt = performance.now();
    stream.firstLevel ??= frag.level;
    // payload is after any unwrapping (see makeLoader in shared.js), so a disguised segment
    // counts as video.
    stream.rates.push({ level: frag.level, bytes: payload?.byteLength || frag.stats.total, duration: frag.duration });
    if (stream.rates.length > 8) stream.rates.shift();
    if (stream === big()) renderBar();
  });
  for (const e of [Hls.Events.MANIFEST_LOADED, Hls.Events.LEVEL_LOADED, Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.SUBTITLE_TRACK_LOADED]) {
    hls.on(e, recovered('playlist'));
  }
  hls.on(Hls.Events.LEVEL_LOADED, (_e, { details }) => {
    stream.playlistAt = performance.now();
    if (details.endSN > stream.edgeSN) {
      stream.edgeSN = details.endSN;
      stream.edgeAt = stream.playlistAt;
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, { levels }) => {
    stream.levels = levels.length;
    // Start on the best quality, and let Auto drop down if the connection can't keep up, rather
    // than starting low and working up.
    const picked = pick ? levels.findIndex((l) => l.bitrate === pick.bitrate && l.height === pick.height) : -1;
    if (picked >= 0) {
      stream.quality = picked;
      hls.currentLevel = picked; // held there, as before the retry
    } else if (levels.length > 1) {
      hls.startLevel = bestLevel(levels);
    }
    stream.status = 'Playing'; // headers and disguised segments are in the stream's details
    render();
    startPlayback(stream);
  });
  // FRAG_CHANGED fires when a segment starts playing, so this is the quality on screen, not the
  // one being downloaded ahead.
  hls.on(Hls.Events.FRAG_CHANGED, (_e, { frag }) => {
    if (stream.retrying) {
      stream.retrying = false;
      const n = stream.retries;
      stream.recovered = `back after ${n ? `${n} automatic ${n === 1 ? 'retry' : 'retries'}` : 'Retry'} (${new Date().toLocaleTimeString()})`;
      stream.recoveredUntil = Date.now() + 10000;
      setTimeout(render, 10000);
      render();
    }
    stream.retries = 0; // it plays: a later drop gets every automatic try again
    if (frag.level === stream.playingLevel) return;
    stream.playingLevel = frag.level;
    render();
  });
  hls.on(Hls.Events.LEVELS_UPDATED, () => render());
  hls.on(Hls.Events.BUFFER_CODECS, (_e, tracks) => {
    const video = tracks.video ?? tracks.audiovideo;
    if (!video?.codec || video.codec === stream.codec) return;
    stream.codec = video.codec;
    stream.codecContainer = video.container;
    checkHardware(stream);
  });
  hls.loadSource(source.url);
  hls.attachMedia(video);
}

// A few words on why a load failed, for the line over the video.
function shortReason(data) {
  if (data.response?.text?.startsWith('not a playlist')) return "the server sent something that isn't a stream";
  if (data.response?.code) return `server answered HTTP ${data.response.code}`;
  if (/TimeOut$/.test(data.details)) return 'the server took too long';
  return data.details;
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

// Why a stream stopped, in plain words.
function stopReason(data, code) {
  if (/^not a playlist/.test(data.response?.text ?? '') || /ParsingError$/.test(data.details)) return "the server sent something that isn't a playlist";
  if (code >= 500) return `the server had an error (HTTP ${code})`;
  if (code >= 400) return `the server refused the link (HTTP ${code})`;
  if (/Timeout$/.test(data.details)) return 'the server took too long to answer';
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return `the video couldn't be decoded (${data.details})`;
  if (data.type !== Hls.ErrorTypes.NETWORK_ERROR) return `playback hit a problem (${data.details})`;
  return "the server didn't answer (the connection dropped or couldn't be made)";
}

// Counts down to the next automatic try, saying why the stream stopped.
function scheduleRetry(s, reason, detail) {
  const n = s.retries + 1;
  const total = RETRY_DELAYS_S.length;
  const at = Date.now() + RETRY_DELAYS_S[s.retries] * 1000;
  const what = s.retries ? `Retry ${s.retries} of ${total} didn't work: ${reason}` : `The stream stopped: ${reason}`;
  s.status = `Stopped · retrying soon (try ${n} of ${total})`;
  console.error(`[stream-sniffer] ${what}; retrying in ${RETRY_DELAYS_S[s.retries]} s:`, detail);
  logEvent(s, `${what}; retrying in ${RETRY_DELAYS_S[s.retries]} s (${detail})`);
  const tick = () => {
    const left = Math.ceil((at - Date.now()) / 1000);
    if (left <= 0) return retry(s, { retries: n, lastReason: reason });
    s.errorShort = `${what}. Retrying in ${left} s (try ${n} of ${total}).`;
    s.error = `${s.errorShort} (${detail})`;
    s.errorIsPause = false;
    render();
  };
  s.retryTimer = setInterval(tick, 1000);
  tick();
}

// Starts a stopped stream again in its slot, with the same link and headers.
// Only once per stream: a second press (a double-click, or Retry in both the message and the
// menu) would otherwise start a second copy before the first replaced this one. A quality picked
// by hand carries over.
function retry(s, opts = {}) {
  clearInterval(s.retryTimer);
  const slot = streams.indexOf(s);
  if (slot < 0 || s.restarting) return; // removed or replaced meanwhile, or already restarting
  s.restarting = true;
  const picked = s.quality >= 0 ? s.hls?.levels[s.quality] : null;
  const pick = picked && { bitrate: picked.bitrate, height: picked.height };
  startStream(s.source, slot, { ...opts, pick }).catch((err) => failPage(err.message));
}
const retryById = (id) => {
  const s = streams.find((x) => x.id === id);
  if (s) retry(s, { manual: true });
};

async function stopStream(s) {
  clearInterval(s.retryTimer);
  s.hls?.destroy();
  s.hls = null;
  s.video.removeAttribute('src');
  s.video.load();
  // The relay bridge still fetches through this stream's header rule while it casts.
  if (bridge?.cast.includes(s) && !bridge.stopped) return;
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
      s.status += ' · muted (autoplay policy), unmute with the speaker button';
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
  // Moving and resizing both pictures makes Chrome skip a frame or two; not worth a warning.
  oldBig.settleFrom = oldSmall.settleFrom = Date.now();
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
    v.hidden = i === -1 || streams[i].casting;
    v.classList.toggle('tucked', i > 0 && smallHidden);
    v.removeAttribute('style'); // the big one fills the tab; the small one is placed below
    if (i > 0) placeSmall(v);
  }
  placeRemoveBtn();
}

// The – and × sit inside the small picture's top-right, clear of the corner that resizes it.
function placeRemoveBtn() {
  const small = streams[1];
  removeSmallBtn.hidden = hideSmallBtn.hidden = !small || small.casting || smallHidden;
  if (removeSmallBtn.hidden) return;
  const r = small.video.getBoundingClientRect();
  Object.assign(removeSmallBtn.style, { left: `${r.right - CORNER - 30}px`, top: `${r.top + 6}px` });
  Object.assign(hideSmallBtn.style, { left: `${r.right - CORNER - 58}px`, top: `${r.top + 6}px` });
}

// The small picture can be hidden while its stream keeps playing. Swapping still works: the
// stream swapped out becomes the hidden one. The bar's "Show small picture" (or H) brings it
// back. Remembered, like its place, so a reload keeps it hidden.
let smallHidden = false;
function setSmallHidden(hide) {
  smallHidden = hide;
  layout();
  render();
  chrome.storage.local.set({ smallHidden }).catch((err) => failPage(`Couldn't save whether the small picture is hidden: ${err.message}`));
}
hideSmallBtn.addEventListener('click', () => setSmallHidden(true));
showSmallBtn.addEventListener('click', () => setSmallHidden(false));
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
  .get(['smallBox', 'smallHidden'])
  .then(({ smallBox: saved, smallHidden: hidden }) => {
    if (saved) smallBox = saved;
    smallHidden = !!hidden;
    layout();
    render();
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
    if (!s.bufferingSince) logEvent(s, 'buffering: the video is waiting for data');
    s.bufferingSince ??= new Date().toLocaleTimeString();
    render();
  });
  v.addEventListener('playing', () => {
    const s = streamOf(v);
    if (!s) return;
    s.settleFrom = Date.now(); // starting (or resuming) makes Chrome skip a frame or two
    if (s.bufferingSince) logEvent(s, `playing again (it had been buffering since ${s.bufferingSince})`);
    s.bufferingSince = null;
    // "Keeps pausing" describes the video being stopped; once it plays, that's no longer true.
    if (s.errorIsPause) {
      s.error = s.errorShort = '';
      s.errorIsPause = false;
    }
    s.lastProblem = s.lastProblemShort = '';
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
      fail(s, `The video keeps pausing (again at ${at}, right after the player resumed it). Press play to try again.`);
      s.errorIsPause = true; // cleared once it plays again (see 'playing')
      return;
    }
    s.resumedAt = now;
    s.resumes++;
    logEvent(s, 'paused by something other than the player; resuming');
    s.lastResume = at;
    render();
    v.play().catch((err) => fail(s, `Couldn't resume after a pause: video.play() failed: ${err.message}`));
  });
  v.addEventListener('resize', () => {
    render(); // the quality readout follows
    if (streamOf(v)) checkHardware(streamOf(v));
  });
  countFrames(v);
  for (const e of ['play', 'pause', 'volumechange', 'timeupdate', 'durationchange']) {
    v.addEventListener(e, () => streamOf(v) === big() && renderBar());
  }
  v.addEventListener('dblclick', (e) => {
    if (streamOf(v) !== big()) return; // the small one swaps on click instead
    e.preventDefault();
    toggleFullscreen();
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

// The stream's frame rate, from the spacing of its frames: the typical (median) gap in video
// time between frames shown one after another, over 60 of them, snapped to the usual rates.
// Lost frames leave bigger gaps, which the median ignores, so they don't lower it.
function countFrames(v) {
  let last = null; // the previous frame shown: { s, mediaTime, frames }
  let gaps = []; // seconds of video between consecutive frames shown
  const tick = (_now, meta) => {
    const s = streamOf(v);
    // Gaps in the timeline: a frame shown later than the next one was due means the frames in
    // between weren't shown. Some the computer dropped (the browser counts those); the rest were
    // never in the stream (see watchFrames). Jumps of a second or more are seeks, not gaps.
    if (s?.fps && last?.s === s) {
      const elapsed = meta.mediaTime - last.mediaTime;
      const notShown = Math.round(elapsed * s.fps) - (meta.presentedFrames - last.frames);
      if (elapsed > 0 && elapsed < 1 && notShown > 0) s.gapFrames += notShown;
    }
    if (s && last?.s === s && meta.presentedFrames - last.frames === 1) {
      const gap = meta.mediaTime - last.mediaTime;
      if (gap > 0 && gap < 0.2) gaps.push(gap);
    } else if (last?.s !== s) {
      gaps = [];
    }
    last = s && { s, mediaTime: meta.mediaTime, frames: meta.presentedFrames };
    if (gaps.length >= 60) {
      const beat = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
      const fps = snapFps(1 / beat);
      // Off the beat: a gap that isn't a whole number of frames (bunched frames, or a late one).
      // Whole multiples are frames that weren't shown, counted elsewhere.
      const offBeat = gaps.filter((g) => Math.abs(g / beat - Math.round(g / beat)) > 0.25 || g / beat < 0.75).length;
      const uneven = offBeat / gaps.length;
      gaps = [];
      if (s.fps !== fps || s.uneven !== uneven) {
        s.fps = fps;
        s.uneven = uneven;
        render(); // the bar, and the menu's timing note
      }
    }
    v.requestVideoFrameCallback(tick);
  };
  v.requestVideoFrameCallback(tick);
}

// Every second, for each picture on screen: frames Chrome's video player skipped (decoded but
// never shown, as the browser counts them; see skipReason) and frames missing from the stream
// itself (timeline gaps the player didn't account for). The last 10 s of them show over the
// video; totals in the menu.
const FRAME_WINDOW_MS = 10000;
const SETTLE_MS = 2000;
setInterval(() => {
  let changed = false;
  for (const s of streams) {
    const shown = s.hls && !s.stopped && !document.hidden && !s.video.paused && !(s !== big() && smallHidden);
    const dropped = s.video.getVideoPlaybackQuality().droppedVideoFrames;
    const newDropped = shown && s.droppedSeen != null ? Math.max(0, dropped - s.droppedSeen) : 0;
    s.droppedSeen = dropped;
    const missing = shown ? Math.max(0, s.gapFrames - newDropped) : 0;
    s.gapFrames = 0;
    if (newDropped || missing) {
      // Frames skipped just after a picture starts playing or is swapped (see settleFrom) count in
      // the menu's totals but not in the warning over the video. The count runs once a second,
      // so allow 2 s.
      const settling = Date.now() - (s.settleFrom ?? 0) < SETTLE_MS;
      if (!settling || missing) s.frameEvents.push({ at: Date.now(), dropped: settling ? 0 : newDropped, missing });
      s.droppedTotal += newDropped;
      s.missingTotal += missing;
      changed = true;
    }
    const recent = s.frameEvents.filter((e) => Date.now() - e.at < FRAME_WINDOW_MS);
    if (recent.length !== s.frameEvents.length) changed = true;
    s.frameEvents = recent;
  }
  if (changed) render();
}, 1000);

function framesWarning(s) {
  if (!frameWarnings) return '';
  const dropped = s.frameEvents.reduce((n, e) => n + e.dropped, 0);
  const missing = s.frameEvents.reduce((n, e) => n + e.missing, 0);
  if (!dropped && !missing) return '';
  const parts = [
    dropped && `${dropped} skipped by Chrome's video player (${skipReason(s)})`,
    missing && `${missing} missing from the stream itself (the source skipped them)`,
  ].filter(Boolean);
  const cadence = cadenceNote(s);
  return `Frames in the last 10 s: ${parts.join(' · ')}${cadence ? ` · ${cadence}` : ''}`;
}

// Why Chrome skipped frames: it shows each one when its timestamp says, in step with the sound,
// and skips any that land late. Uneven timestamps in the stream make some land late however fast
// the computer is; otherwise it's decoding that couldn't keep up.
const UNEVEN = 0.05; // off-beat share above which a stream's timing counts as uneven
function skipReason(s) {
  if (s.uneven >= UNEVEN) {
    return `the stream's frame timing is uneven, ${Math.round(s.uneven * 100)}% of frames off their beat, so some land late; that's the stream, not your computer`;
  }
  // Chrome doesn't say which; whether the format has hardware decoding is the best clue.
  if (s.hardware === false) return 'this format has no hardware decoding here, so the processor decodes it and may not keep up';
  if (s.hardware === true) return 'late for their slot; not decoding speed, this format is decoded in hardware';
  return `late for their slot, or decoding couldn't keep up${streams.length > 1 ? '; two streams are playing' : ''}`;
}

// Whether the browser can decode the stream's video format in hardware (its own answer:
// "power efficient" means a hardware decoder). Asked once the format and size are known.
async function checkHardware(s) {
  if (!s.codec || !s.codecContainer || !navigator.mediaCapabilities) return;
  const v = s.video;
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: {
        contentType: `${s.codecContainer}; codecs="${s.codec}"`,
        width: v.videoWidth || 1920,
        height: v.videoHeight || 1080,
        bitrate: Math.round(measuredMbps(s) * 1e6) || 8e6,
        framerate: s.fps || 60,
      },
    });
    s.hardware = info.supported ? info.powerEfficient : false;
  } catch (err) {
    console.warn('[stream-sniffer] could not ask about hardware decoding:', err);
    s.hardware = null;
  }
  render();
}

// e.g. "H.264, hardware decoding available"
function decodingText(s) {
  if (!s.codec) return '';
  const name = codecName(s.codec) || s.codec;
  if (s.hardware == null) return name;
  return `${name}, ${s.hardware ? 'hardware decoding available' : 'no hardware decoding for this format: the processor decodes it'}`;
}

// The display's refresh rate, from the browser's own frame timing (the median gap over 2 s,
// which a busy moment doesn't skew). Measured again when the window may have moved to another
// screen.
const COMMON_HZ = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
let displayHz = 0;
let measuringHz = false;
function measureHz() {
  if (document.hidden || measuringHz) return;
  measuringHz = true;
  const gaps = [];
  let prev = null;
  const step = (t) => {
    if (prev != null) gaps.push(t - prev);
    prev = t;
    if (gaps.length < 120) return requestAnimationFrame(step);
    measuringHz = false;
    const median = gaps.sort((a, b) => a - b)[gaps.length >> 1];
    displayHz = snapTo(1000 / median, COMMON_HZ, 2);
    render();
  };
  requestAnimationFrame(step);
}
measureHz();
let hzTimer;
const remeasureHz = () => {
  clearTimeout(hzTimer);
  hzTimer = setTimeout(measureHz, 1000);
};
addEventListener('resize', remeasureHz);
document.addEventListener('fullscreenchange', remeasureHz);
document.addEventListener('visibilitychange', remeasureHz);

// A frame rate that doesn't divide the display's refresh rate can't be shown evenly: some
// frames stay up longer than others (50 fps on 60 Hz: every fifth frame twice as long). That
// steady hitch isn't dropped frames. Only said for the usual rates, which are measured reliably.
function cadenceNote(s) {
  const fps = s.fps;
  if (!frameWarnings || !COMMON_FPS.includes(fps) || !COMMON_HZ.includes(displayHz)) return '';
  if (fps > displayHz || displayHz % fps === 0) return '';
  return `${fps} fps on a ${displayHz} Hz screen: a slight steady hitch, not lost frames`;
}

// The menu's switch for the warnings above (lost frames, refresh-rate hitches). The counting
// goes on either way; the totals stay in the menu.
let frameWarnings = true;
const frameWarningsBox = document.getElementById('frame-warnings');
chrome.storage.local
  .get('frameWarnings')
  .then(({ frameWarnings: saved }) => {
    frameWarnings = saved !== false;
    frameWarningsBox.checked = frameWarnings;
    render();
  })
  .catch((err) => failPage(`Couldn't read whether frame warnings are on: ${err.message}`));
frameWarningsBox.addEventListener('change', () => {
  frameWarnings = frameWarningsBox.checked;
  render();
  chrome.storage.local.set({ frameWarnings }).catch((err) => failPage(`Couldn't save whether frame warnings are on: ${err.message}`));
});

// Over the recent segments of the quality on screen (any quality until one is on screen).
function measuredMbps(s) {
  const same = s.rates.filter((r) => r.level === s.playingLevel);
  const rs = same.length ? same : s.rates;
  const seconds = rs.reduce((sum, r) => sum + r.duration, 0);
  return seconds ? (rs.reduce((sum, r) => sum + r.bytes, 0) * 8) / seconds / 1e6 : 0;
}

// "1080p", or the bitrate for a stream that doesn't say its resolution. A playlist linked
// directly (no list of qualities) says neither.
function levelName(l) {
  if (l?.height) return `${l.height}p`;
  if (l?.bitrate) return `${Math.round(l.bitrate / 1000)} kbps`;
  return 'unknown quality';
}

// Which quality is on screen and why, e.g. "720p, picked automatically from 2 quality levels".
function qualityText(s) {
  const levels = s.hls?.levels ?? [];
  if (!levels.length) return '';
  const n = levels.length;
  const count = `${n} quality level${n === 1 ? '' : 's'}`;
  if (s.playingLevel < 0) return count;
  // The decoded picture's real height beats what the playlist claims, and works when it claims
  // nothing.
  const now = s.video.videoHeight ? `${s.video.videoHeight}p` : levelName(levels[s.playingLevel]);
  if (n === 1) return `${now}, the only quality level`;
  if (s.quality < 0) return `${now}, picked automatically from ${count}`;
  if (s.quality !== s.playingLevel) return `${now}, switching to ${levelName(levels[s.quality])} (of ${count})`;
  return `${now}, picked by you (of ${count})`;
}

// The bar's quality menu. Auto lets hls.js follow the connection speed; a picked level stays
// until changed. The switch happens at the next segment, so the picture doesn't stop.
function setQuality(streamId, level) {
  const s = streams.find((x) => x.id === streamId);
  if (!s?.hls) return;
  s.quality = level;
  s.hls.nextLevel = level;
  render();
}

// The short line over the video while a stream struggles; the full story is in its details.
function health(s) {
  if (s.error) return ''; // a failed stream isn't buffering or retrying; its error line says why
  if (s.retrying && !s.stopped) return s.retryNote;
  if (s.lastProblemShort) return s.lastProblemShort;
  return s.bufferingSince ? 'Buffering…' : '';
}

// The technical facts about a stream, in a collapsed Details section in the menu.
function streamDetails(s) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    s.error && `Error: ${s.error}`,
    s.lastProblem && `Last problem ${s.lastProblem}`,
    !s.error && s.bufferingSince && `Buffering since ${s.bufferingSince}, waiting for video data`,
    !s.error && s.bufferingSince && s.lastSkipped && `Last skipped playlist problem ${s.lastSkipped}`,
    s.mode && `Headers: ${s.mode}`,
    s.unwrapped && 'Segments are disguised as images; decoding them',
    (s.droppedTotal || s.missingTotal) &&
      `Frames so far: ${s.droppedTotal} skipped by Chrome's video player, ${s.missingTotal} missing from the stream`,
    s.uneven >= UNEVEN && `Frame timing uneven: ${Math.round(s.uneven * 100)}% of frames off their beat`,
    decodingText(s),
    cadenceNote(s),
    s.skipped && `hls.js skipped ${plural(s.skipped, 'playlist problem')} (last ${s.lastSkipped})`,
    s.resumes && `Resumed after ${plural(s.resumes, 'pause')} (last ${s.lastResume})`,
    ignoredPauses && `Ignored ${plural(ignoredPauses, 'pause request')} from Chrome's media controls (last ${lastIgnoredPause})`,
    `Stream URL: ${s.source.url}`,
  ].filter(Boolean);
}

// A message over the video, with an × that hides it, and Retry for a stopped stream.
const dismissed = new Set();
let renderedProblems = '';
function retryButton(streamId) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'retry';
  b.textContent = 'Retry';
  b.title = 'Start this stream again, with the same link';
  b.addEventListener('click', () => retryById(streamId));
  return b;
}
// A short note after a message's text, gone after 1.5 s.
function flashNote(after, text, cls) {
  after.parentElement?.querySelector('.copied, .copy-failed')?.remove();
  const note = document.createElement('span');
  note.className = cls;
  note.textContent = text;
  after.after(note);
  setTimeout(() => note.remove(), 1500);
}

function problemLine({ cls, text, copy, key, retryId }) {
  const p = document.createElement('p');
  p.className = cls;
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  span.dataset.copy = copy ?? text; // render() keeps it current, e.g. a countdown
  // A click copies the message as it reads now, with its technical detail.
  span.title = 'Click to copy';
  span.addEventListener('click', () => {
    navigator.clipboard.writeText(span.dataset.copy).then(
      () => flashNote(span, 'Copied', 'copied'),
      (err) => flashNote(span, `Couldn't copy: ${err.message}`, 'copy-failed')
    );
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dismiss';
  close.textContent = '×';
  close.title = close.ariaLabel = 'Dismiss this message';
  close.addEventListener('click', () => {
    dismissed.add(key);
    render();
  });
  p.append(span);
  if (retryId) p.append(retryButton(retryId));
  p.append(close);
  return p;
}

let renderedEntries = '';
let renderedShape = '';
const openDetails = new Set(); // sources whose Details section is open (a retry keeps the source)
function render() {
  const label = (s) => (streams.length > 1 ? (s === big() ? 'Big: ' : 'Small: ') : '');
  const lines = [];
  // key: what dismissing remembers. Usually the text, so a new or changed message (they carry a
  // time) still shows; a retry countdown keeps one key while its seconds tick.
  const line = (cls, text, more = {}) => lines.push({ cls, text, key: text, retryId: null, ...more });
  if (pageError) line('error', pageError);
  for (const s of streams) {
    // The short form over the video; a click copies the full one, technical detail included.
    if (s.error) {
      line('error', `${label(s)}${s.errorShort} (details in ⚙)`, {
        copy: label(s) + s.error,
        retryId: s.stopped ? s.id : null,
        ...(s.retryTimer && { key: `countdown:${s.id}` }),
      });
    }
    if (health(s)) line('warn', label(s) + health(s));
    if (s.recovered && Date.now() < s.recoveredUntil) line('ok', label(s) + s.recovered[0].toUpperCase() + s.recovered.slice(1));
    // One key while drops go on, so dismissing it keeps it hidden until they stop for 10 s.
    if (framesWarning(s)) line('warn', label(s) + framesWarning(s), { key: `frames:${s.id}` });
  }
  // Forgetting dismissed messages that are gone keeps the set small.
  const keys = new Set(lines.map((l) => l.key));
  for (const k of dismissed) if (!keys.has(k)) dismissed.delete(k);
  const shown = lines.filter((l) => !dismissed.has(l.key));
  // Rebuilt only when the set of messages changes, so an × or Retry isn't swapped out from under
  // a click; a countdown just updates its text.
  const structure = JSON.stringify(shown.map(({ cls, key, retryId }) => [cls, key, retryId]));
  if (structure !== renderedProblems) {
    renderedProblems = structure;
    problemsEl.replaceChildren(...shown.map(problemLine));
  } else {
    shown.forEach((l, i) => {
      const span = problemsEl.children[i].firstChild;
      if (span.textContent !== l.text) span.textContent = l.text;
      span.dataset.copy = l.copy ?? l.text;
    });
  }

  // Rebuilt only when its text changes, so a link isn't swapped out from under a click.
  const entries = streams.map((s, i) => ({
    detailsKey: s.source.capId ?? s.source.url,
    heading:
      streams.length < 2
        ? 'Now playing'
        : i === 0
          ? 'Big screen'
          : smallHidden
            ? 'Small screen, hidden (press S to swap, H to show it)'
            : 'Small screen (click it or press S to swap)',
    pageUrl: s.source.pageUrl,
    pageTitle: s.source.pageTitle,
    // The short story; the rest is under Details.
    status: [s.status, s.recovered, qualityText(s)].filter(Boolean).join(' · '),
    details: streamDetails(s),
    retryId: s.stopped ? s.id : null,
  }));
  if (JSON.stringify(entries) !== renderedEntries) {
    renderedEntries = JSON.stringify(entries);
    // Rebuilt only when something clickable changes (which stream, its link, Retry), so a status
    // update (frame counts, quality) doesn't swap Details or a link out from under a click; the
    // text updates in place.
    const shape = JSON.stringify(entries.map((e) => [e.detailsKey, e.pageUrl, e.pageTitle, e.retryId]));
    if (shape !== renderedShape) {
      renderedShape = shape;
      streamsEl.replaceChildren(...entries.map(streamEntry));
    }
    entries.forEach((e, i) => fillStreamEntry(streamsEl.children[i], e));
  }

  renderBar();

  const b = big()?.source;
  document.title = b?.pageUrl ? `▶ ${b.pageTitle || b.pageUrl}` : 'Stream Sniffer Player';
}

// Shows which page a stream came from and its status, with the rest under Details. This builds
// the parts; fillStreamEntry sets their text.
function streamEntry(e) {
  const el = document.createElement('div');
  el.className = 'stream';
  const h = document.createElement('h2');
  el.append(h);
  if (e.pageUrl) {
    const p = document.createElement('p');
    p.className = 'small';
    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = e.pageUrl;
    a.textContent = e.pageTitle || e.pageUrl;
    a.title = e.pageUrl;
    p.append('From ', a);
    el.append(p);
  }
  const status = document.createElement('p');
  status.className = 'status muted small';
  const details = document.createElement('details');
  details.open = openDetails.has(e.detailsKey);
  details.addEventListener('toggle', () => (details.open ? openDetails.add(e.detailsKey) : openDetails.delete(e.detailsKey)));
  const summary = document.createElement('summary');
  summary.className = 'muted small';
  summary.textContent = 'Details';
  const lines = document.createElement('div');
  lines.className = 'lines';
  details.append(summary, lines);
  el.append(status);
  if (e.retryId) el.append(retryButton(e.retryId));
  el.append(details);
  return el;
}

function fillStreamEntry(el, e) {
  el.querySelector('h2').textContent = e.heading;
  el.querySelector('.status').textContent = e.status;
  const lines = el.querySelector('.lines');
  if (JSON.stringify([...lines.children].map((p) => p.textContent)) === JSON.stringify(e.details)) return;
  lines.replaceChildren(
    ...e.details.map((line) => {
      const p = document.createElement('p');
      p.className = 'small';
      p.textContent = line;
      return p;
    })
  );
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

// The streams also go to session storage as the last session, for the popup's "Reopen last
// player" after this tab is closed. Like the sources it points to, it lasts until Chrome quits
// or the extension reloads.
function persist() {
  const caps = streams.map((s) => s.source.capId);
  history.replaceState(null, '', `?${new URLSearchParams(caps.map((id) => ['cap', id]))}`);
  if (!caps.length) return;
  chrome.storage.session.set({ lastSession: caps }).catch((err) => failPage(`Couldn't save this session for reopening: ${err.message}`));
}

// Pop the big video out into Chrome's floating picture-in-picture window, or bring it back.
// The label follows the real state, so closing the floating window by hand updates it too.
const popoutBtn = document.getElementById('popout');
function syncPopout() {
  const out = !!document.pictureInPictureElement;
  popoutBtn.ariaLabel = out ? 'Back to tab' : 'Pop out';
  popoutBtn.title = out ? 'Back to tab' : 'Pop out: play in a floating window that stays on top';
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

// The control bar for the big picture, in place of Chrome's (see player.html). Icons are
// Material Design icons, as in Chrome's own controls.
const ICONS = {
  play: 'M8 5v14l11-7z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  popout: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  exitFullscreen: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
};
function setIcon(btn, name) {
  if (btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}
const bar = document.getElementById('bar');
const playBtn = document.getElementById('play');
const muteBtn = document.getElementById('mute');
const volumeEl = document.getElementById('volume');
const liveBtn = document.getElementById('live');
const timeEl = document.getElementById('time');
const qualityWrap = document.getElementById('quality-wrap');
const qualityBtn = document.getElementById('quality');
const qualityMenu = document.getElementById('quality-menu');
const fullscreenBtn = document.getElementById('fullscreen');
setIcon(playBtn, 'play');
setIcon(popoutBtn, 'popout');
setIcon(fullscreenBtn, 'fullscreen');

function clock(t) {
  t = Math.floor(t);
  const [h, m, sec] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
}

// How far behind the live edge counts as "behind": a few segments.
function behindLive(s) {
  const edge = s.hls.liveSyncPosition;
  const target = s.hls.latestLevelDetails?.targetduration || 2;
  return edge != null && edge - s.video.currentTime > Math.max(10, 3 * target);
}

function renderBar() {
  const s = big();
  bar.hidden = !s?.hls;
  if (bar.hidden) return closeQualityMenu();
  const v = s.video;
  // Live streams just play (see the 'pause' listener), so there's no pause button; play shows
  // only for a video that stopped and needs a press to start again.
  playBtn.hidden = !v.paused;
  showSmallBtn.hidden = !(smallHidden && streams[1] && !streams[1].casting);
  const silent = v.muted || v.volume === 0;
  setIcon(muteBtn, silent ? 'muted' : 'volume');
  muteBtn.ariaLabel = silent ? 'Unmute' : 'Mute';
  muteBtn.title = `${muteBtn.ariaLabel} (M)`;
  volumeEl.value = silent ? 0 : v.volume;

  const live = !!s.hls.latestLevelDetails?.live;
  liveBtn.hidden = !live;
  timeEl.hidden = live;
  if (live) {
    const behind = behindLive(s);
    liveBtn.textContent = 'LIVE';
    liveBtn.classList.toggle('at-edge', !behind);
    liveBtn.title = behind ? 'Behind live: click to jump to live' : 'Playing live';
  } else {
    timeEl.textContent = Number.isFinite(v.duration) ? `${clock(v.currentTime)} / ${clock(v.duration)}` : clock(v.currentTime);
  }

  // The resolution on screen; with more than one quality it opens the quality menu.
  const levels = s.hls.levels ?? [];
  const playing = levels[s.playingLevel];
  // e.g. "1080p60" and "6.2 Mbps"
  resolutionEl.textContent = v.videoHeight ? `${v.videoHeight}p${s.fps || ''}` : playing ? levelName(playing) : '';
  bitrateEl.textContent = rateText(measuredMbps(s));
  qualityWrap.hidden = !resolutionEl.textContent;
  qualityBtn.disabled = levels.length < 2;
  const what = 'Resolution and frame rate on screen, and the bitrate measured over the last few segments';
  qualityBtn.title = levels.length < 2 ? `${what}. This stream has only one quality.` : `${what}. Click to pick a quality (now: ${s.quality < 0 ? 'Auto' : 'picked by you'}).`;
  if (qualityBtn.disabled) closeQualityMenu();
  else if (!qualityMenu.hidden) fillQualityMenu(s);
}

// Auto first, then each quality, highest first. Rebuilt only when it changes, so an item isn't
// swapped out from under a click.
function fillQualityMenu(s) {
  const h = s.video.videoHeight;
  const items = [
    { index: -1, name: s.quality < 0 && h ? `Auto (${h}p)` : 'Auto', rate: '' },
    ...s.hls.levels
      .map((l, index) => ({ index, name: levelName(l), rate: l.bitrate ? `${(l.bitrate / 1e6).toFixed(1)} Mbps` : '', bitrate: l.bitrate }))
      .sort((a, b) => b.bitrate - a.bitrate),
  ];
  const key = JSON.stringify([s.id, s.quality, items]);
  if (qualityMenu.dataset.key === key) return;
  qualityMenu.dataset.key = key;
  qualityMenu.replaceChildren(
    ...items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'menuitemradio';
      b.setAttribute('aria-checked', String(it.index === s.quality));
      const name = document.createElement('span');
      name.textContent = it.name;
      b.append(name);
      if (it.rate) {
        const rate = document.createElement('span');
        rate.className = 'rate';
        rate.textContent = it.rate;
        b.append(rate);
      }
      b.addEventListener('click', () => {
        closeQualityMenu();
        setQuality(s.id, it.index);
      });
      return b;
    })
  );
}
function openQualityMenu() {
  qualityMenu.hidden = false;
  qualityBtn.ariaExpanded = 'true';
  fillQualityMenu(big());
}
function closeQualityMenu() {
  qualityMenu.hidden = true;
  qualityBtn.ariaExpanded = 'false';
}
qualityBtn.addEventListener('click', () => (qualityMenu.hidden ? openQualityMenu() : closeQualityMenu()));
addEventListener('pointerdown', (e) => {
  if (!qualityWrap.contains(e.target)) closeQualityMenu();
});

playBtn.addEventListener('click', () => {
  const s = big();
  s?.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
});
function toggleMute() {
  const s = big();
  if (!s?.hls) return;
  const v = s.video;
  if (v.muted || v.volume === 0) {
    v.muted = false;
    if (v.volume === 0) v.volume = 0.5;
  } else {
    v.muted = true;
  }
  s.autoMuted = false;
}
muteBtn.addEventListener('click', toggleMute);
volumeEl.addEventListener('input', () => {
  const s = big();
  if (!s?.hls) return;
  s.video.volume = Number(volumeEl.value);
  s.video.muted = s.video.volume === 0;
  s.autoMuted = false;
});
liveBtn.addEventListener('click', () => {
  const s = big();
  if (s?.hls && behindLive(s)) s.video.currentTime = s.hls.liveSyncPosition;
});

// Full screen takes the whole page, so the small picture and messages stay. (Chrome's own
// would take just the video, and won't let the page switch it over afterwards.) The button,
// F, and a double-click on the big picture all toggle it.
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    failPage(`Couldn't change full screen: ${err.message}`);
  }
}
fullscreenBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  setIcon(fullscreenBtn, on ? 'exitFullscreen' : 'fullscreen');
  fullscreenBtn.ariaLabel = on ? 'Exit full screen' : 'Full screen';
  fullscreenBtn.title = on ? 'Exit full screen (F or Esc)' : 'Full screen (F, or double-click the video)';
});

// F: full screen. M: mute. S: swap the big and small pictures. H: hide or show the small one.
// Esc: close the quality menu.
// Not while typing in the form.
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input:not([type=range]), select, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'escape') return closeQualityMenu();
  if (key === 'f') toggleFullscreen();
  else if (key === 'm') toggleMute();
  else if (key === 's' && streams.length > 1) swap();
  else if (key === 'h' && streams.length > 1) setSmallHidden(!smallHidden);
  else return;
  e.preventDefault();
});

// The bar and the mouse pointer fade out once the mouse has rested for a few seconds, as with
// Chrome's controls. Not while the pointer is on the bar or a menu is open.
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (big()?.hls && menu.hidden && qualityMenu.hidden && !bar.matches(':hover')) document.body.classList.add('idle');
    else wake();
  }, 3000);
}
for (const e of ['pointermove', 'pointerdown', 'keydown']) addEventListener(e, wake);
wake();

// The popup's "Add to player" sends this to the player tab used last.
const myTabId = chrome.tabs.getCurrent().then((t) => t.id);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'add-stream') return false;
  myTabId.then(async (id) => {
    if (msg.tabId !== id) return;
    try {
      const source = await loadSource(msg.capId);
      const slot = Math.min(streams.length, MAX_STREAMS - 1);
      if (slot === 1 && smallHidden) setSmallHidden(false); // a stream just added should be seen
      await startStream(source, slot);
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
// That's why this tab has to stay open while casting. With one stream it casts that; with two,
// the relay makes them one channel for the TV, and the cast controls' Swap on TV switches it.
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
// Fit to TV. Chrome's own Cast (Chrome menu → Cast) sends the tab's visible area, so on a 16:9
// TV a tab of any other shape gets black bars. This sizes the window so the tab is 16:9, as big
// as fits on its screen, and then checks the result rather than assuming it.
const fitBtn = document.getElementById('fit-tv');
const fitStatus = document.getElementById('fit-status');
const nextResize = (ms) =>
  new Promise((resolve) => {
    const done = () => (removeEventListener('resize', done), clearTimeout(t), resolve());
    const t = setTimeout(done, ms); // no resize at all is checked below, not assumed fine
    addEventListener('resize', done);
  });
async function fitToTv() {
  let win = await chrome.windows.getCurrent();
  if (win.state !== 'normal') {
    // A full-screen or maximized window can't be given a size; leave that state first.
    await chrome.windows.update(win.id, { state: 'normal' });
    await nextResize(2000);
    win = await chrome.windows.getCurrent();
  }
  // Window sizes are in screen points, innerWidth in CSS pixels, which page zoom scales.
  const zoom = await chrome.tabs.getZoom((await chrome.tabs.getCurrent()).id);
  const frameW = win.width - Math.round(innerWidth * zoom);
  const frameH = win.height - Math.round(innerHeight * zoom);
  const maxW = screen.availWidth - frameW;
  const maxH = screen.availHeight - frameH;
  const w = Math.floor(Math.min(maxW, (maxH * 16) / 9));
  const h = Math.round((w * 9) / 16);
  const width = w + frameW;
  const height = h + frameH;
  await chrome.windows.update(win.id, {
    width,
    height,
    left: screen.availLeft + Math.floor((screen.availWidth - width) / 2),
    top: screen.availTop,
  });
  await nextResize(2000);
  const off = Math.abs(innerWidth - (innerHeight * 16) / 9);
  if (off > 2) {
    throw new Error(`asked for a 16:9 tab, but it came out ${innerWidth}x${innerHeight}. Resize the window by hand: wider and shorter until the TV has no bars.`);
  }
  fitStatus.textContent = `This tab is now ${innerWidth}x${innerHeight} (16:9), so Chrome's Cast fills the TV.`;
}
fitBtn.addEventListener('click', () => {
  fitStatus.textContent = 'Resizing…';
  fitToTv().catch((err) => {
    console.error('[stream-sniffer] Fit to TV failed:', err);
    fitStatus.textContent = `Fit to TV didn't work: ${err.message}`;
  });
});

const relayBtn = document.getElementById('relay');
const setRelay = (msg) => (castStatus.textContent = `Relay: ${msg}`);
let bridge = null;

// cast: the streams being cast, in the order the relay knows them (a job's src indexes this).
function startBridge(id, cast) {
  const b = { id, cast, stopped: false, served: 0 };
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
    if (res.status === 404) return b.fail('the relay no longer knows this stream (did it restart?). Click "Start casting" again.');
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
    const stream = b.cast[job.src ?? 0];
    if (!stream) throw new Error(`the relay asked for stream ${job.src + 1}, but this tab is casting ${b.cast.length}`);
    await allowHost(stream, job.url);
    // A request the stream server never answers would otherwise stay open forever. The relay
    // has asked again long before this (and gives up at 20 s), so this only frees the connection.
    const up = await fetch(job.url, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
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
  // Two streams in the player: cast both as one channel, big one first, so the TV can swap.
  const cast = streams.slice(0, 2);
  setRelay(
    cast.length > 1
      ? `registering both streams with the relay at ${RELAY}, for Swap on TV…`
      : `registering stream with the relay at ${RELAY}…`
  );
  let res;
  try {
    res = await fetch(`${RELAY}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: cast.map((x) => ({ url: x.source.url, label: castLabel(x) })) }),
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
  const b = (bridge = startBridge(reg.id, cast));
  setRelay(cast.length > 1 ? 'checking both streams through this tab…' : 'checking the stream through this tab…');
  const probeRes = await fetch(`${RELAY}/api/streams/${reg.id}/probe`, { method: 'POST' });
  const info = await probeRes.json().catch((err) => ({ error: `relay sent a non-JSON reply (HTTP ${probeRes.status}): ${err.message}` }));
  if (!probeRes.ok || info.error) {
    b.stopped = true;
    setRelay(info.error || `HTTP ${probeRes.status}`);
    return;
  }
  b.info = info;

  // The TV takes over; stop playing here so nothing is downloaded twice. With a channel that
  // means both streams: the TV has them both, one at a time.
  for (const x of cast) {
    // A stream counting down to an automatic retry would start playing here again mid-cast.
    if (x.retryTimer) {
      clearInterval(x.retryTimer);
      x.retryTimer = null;
      x.error = x.errorShort = '';
    }
    if (!x.hls) continue;
    x.hls.destroy();
    x.hls = null;
    x.video.removeAttribute('src');
    x.video.load();
    x.casting = true; // an empty player box while the TV plays is just dead space
    x.status = 'Stopped here while casting. Press Play to watch on this computer again.';
  }
  layout();
  render();
  const frame = document.getElementById('cast-frame');
  frame.src = `${info.castPageUrl}?embed=1`;
  frame.hidden = false;
  frame.style.height = '300px'; // until the cast page reports its real height
  setRelay(
    cast.length > 1
      ? `ready — click "Cast to TV" below, then "Swap on TV" to switch between ${cast.map(castLabel).join(' and ')}. Keep this tab open; it fetches both streams for the TV.`
      : 'ready — click "Cast to TV" below. Keep this tab open; it fetches the stream for the TV.'
  );
});

// What the cast controls call a stream: its page's title and the end of its URL, since two
// streams from one page share a title.
function castLabel(s) {
  const path = new URL(s.source.url).pathname.split('/').filter(Boolean).slice(-2).join('/');
  return s.source.pageTitle ? `${s.source.pageTitle} · ${path}` : `${new URL(s.source.url).host} · ${path}`;
}

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

// The menu's fold-away sections stay as they were left. Only a click saves: init() opens "Play
// a URL" when there's nothing to play, which shouldn't count.
function rememberFold(details, key, name) {
  details.querySelector('summary').addEventListener('click', () => {
    chrome.storage.local
      .set({ [key]: !details.open }) // the click hasn't toggled it yet
      .catch((err) => failPage(`Couldn't save whether "${name}" is open: ${err.message}`));
  });
}
const playUrl = document.getElementById('play-url');
rememberFold(playUrl, 'playUrlOpen', 'Play a URL');

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
  // Not awaited: the streams shouldn't wait on how a menu was left. If starting them fails
  // first, the form stays open (see below): it's the way to recover.
  chrome.storage.local
    .get('playUrlOpen')
    .then(({ playUrlOpen }) => !startFailed && (playUrl.open = playUrlOpen !== false))
    .catch((err) => failPage(`Couldn't read whether "Play a URL" was left open: ${err.message}`));
  for (const [i, source] of sources.entries()) await startStream(source, i);
}
let startFailed = false;
init().catch((err) => {
  startFailed = true;
  playUrl.open = true;
  openMenu(true);
  failPage(err.message);
});
