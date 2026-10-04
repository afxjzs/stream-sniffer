const form = document.getElementById('form');
const video = document.getElementById('video');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
let hls = null;

function showError(msg) {
  console.error('[stream-sniffer]', msg);
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function play({ url, referer, origin }) {
  errorEl.hidden = true;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (!Hls.isSupported()) {
    showError('hls.js is not supported in this browser (no Media Source Extensions).');
    return;
  }

  // Keep the URL reloadable. A popup handoff (?cap=) stays as-is so a reload keeps all headers.
  if (!params.get('cap')) history.replaceState(null, '', `?${new URLSearchParams({ url, referer, origin })}`);

  const res = await chrome.runtime.sendMessage({ type: 'prepare-player', referer, origin });
  if (!res?.ok) {
    showError(`Could not set up request headers: ${res?.error ?? 'no response from background'}`);
    return;
  }
  setStatus(`Loading… (${res.mode})`);

  hls = new Hls();
  hls.on(Hls.Events.ERROR, (_e, data) => {
    const code = data.response?.code;
    const detail = `${data.type} / ${data.details}${code ? ` — HTTP ${code}` : ''}${data.url ? ` — ${data.url}` : ''}`;
    if (data.fatal) {
      showError(`Playback failed: ${detail}`);
      setStatus('');
    } else {
      console.warn('[stream-sniffer] non-fatal hls.js error:', detail);
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    setStatus(`Playing · ${data.levels.length} quality level${data.levels.length === 1 ? '' : 's'} · ${res.mode}`);
    startPlayback();
  });
  hls.loadSource(url);
  hls.attachMedia(video);
}

// Autoplay with sound needs a user gesture on this tab; fall back to muted and say so.
async function startPlayback() {
  try {
    await video.play();
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showError(`video.play() failed: ${err.message}`);
      return;
    }
    video.muted = true;
    try {
      await video.play();
      setStatus(`${statusEl.textContent} · muted (autoplay policy) — unmute in the controls`);
    } catch (err2) {
      showError(`video.play() failed even muted: ${err2.message}`);
    }
  }
}

// Cast via the Remote Playback API. For an hls.js (Media Source) video, Chrome can only do
// this with "media remoting": this browser keeps fetching the stream (with the rewritten
// headers) and forwards the encoded video to the Chromecast. Whether Chrome offers that for
// a given video is Chrome's call, so every outcome is reported to the user.
const castBtn = document.getElementById('cast');
const castStatus = document.getElementById('cast-status');
const setCast = (msg) => (castStatus.textContent = `Cast: ${msg}`);

if (!video.remote) {
  castBtn.disabled = true;
  setCast('this browser has no Remote Playback API.');
} else {
  video.remote.addEventListener('connecting', () => setCast('connecting…'));
  video.remote.addEventListener('connect', () => setCast('casting to TV.'));
  video.remote.addEventListener('disconnect', () => setCast('disconnected.'));
  castBtn.addEventListener('click', async () => {
    if (!hls) {
      setCast('start a stream first.');
      return;
    }
    if (video.remote.state !== 'disconnected') {
      setCast(`already ${video.remote.state}; use the device picker to stop.`);
    }
    try {
      setCast('opening device picker…');
      await video.remote.prompt();
    } catch (err) {
      // NotAllowedError covers both "user closed the picker" and "Chrome refused to show it",
      // so always show Chrome's own message rather than guessing which.
      console.error('[stream-sniffer] remote.prompt failed', err);
      setCast(`${err.name}: ${err.message}`);
    }
  });
}

// Cast via the relay. Some stream servers only answer Chrome itself, so this tab does all the
// fetching: it long-polls the relay for URLs the TV wants, fetches them here (where the
// Referer/Origin rewrite applies), and posts the bytes back. The relay serves them to the TV.
// That's why this tab has to stay open while casting.
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

function startBridge(id) {
  const b = { id, stopped: false, served: 0 };
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
  const s = readForm();
  if (!s.url) {
    setRelay('enter a stream URL first.');
    return;
  }
  await relayReady;
  setRelay(`registering stream with the relay at ${RELAY}…`);
  // Make sure this tab's header rewrite matches the form, since this tab does the fetching.
  const prep = await chrome.runtime.sendMessage({ type: 'prepare-player', referer: s.referer, origin: s.origin });
  if (!prep?.ok) {
    setRelay(`could not set up request headers: ${prep?.error ?? 'no response from background'}`);
    return;
  }
  let res;
  try {
    res = await fetch(`${RELAY}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: s.url }),
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
  const b = (bridge = startBridge(reg.id));
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
  if (hls) {
    hls.destroy();
    hls = null;
    video.removeAttribute('src');
    video.load();
    setStatus('Stopped here while casting. Press Play to watch on this computer again.');
  }
  const frame = document.getElementById('cast-frame');
  frame.src = `${info.castPageUrl}?embed=1`;
  frame.hidden = false;
  setRelay('ready — click "Cast to TV" below. Keep this tab open; it fetches the stream for the TV.');
});

function readForm() {
  const f = new FormData(form);
  return {
    url: f.get('url').trim(),
    referer: f.get('referer').trim(),
    origin: f.get('origin').trim(),
  };
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  play(readForm()).catch((err) => showError(err.message));
});

// Prefill from the popup (?cap=<id> in session storage) or from plain query params, and start.
async function init() {
  let prefill = { url: params.get('url'), referer: params.get('referer'), origin: params.get('origin') };
  const cap = params.get('cap');
  if (cap) {
    const { [`cap:${cap}`]: c } = await chrome.storage.session.get(`cap:${cap}`);
    if (!c) throw new Error('This player link has expired (its captured headers are gone). Reopen it from the popup.');
    prefill = c;
  }
  for (const name of ['url', 'referer', 'origin']) form.elements[name].value = prefill[name] || '';
  if (prefill.url) await play(readForm());
}
init().catch((err) => showError(err.message));
