// Stream Sniffer relay: lets a Chromecast play a stream that only Chrome can fetch.
//
// Some stream servers reject everything that isn't the browser (curl and VLC get 403 even with
// identical headers), so this relay never fetches the stream itself. Instead the extension's
// player tab acts as a "bridge": it long-polls the relay for URLs the TV wants, fetches each one
// through Chrome, and posts the bytes back. The relay rewrites playlists so every link points
// back here, adds CORS, and serves it all on the LAN. It also serves the page that starts the
// Cast session.
//
//   node relay/server.mjs            (no dependencies; Node 18+)
//   RELAY_PORT=8788 RELAY_HOST=192.168.1.20 node relay/server.mjs   (overrides)
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.RELAY_PORT || 8788);
const LAN_HOST = process.env.RELAY_HOST || lanAddress();
const LAN_BASE = `http://${LAN_HOST}:${PORT}`;
// Read on every request, so edits to the cast page apply without restarting the relay.
const CAST_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cast.html');

// How long the TV's request waits for the player tab to deliver, and how long one long-poll
// from the player tab is held open when there is nothing to fetch.
const BRIDGE_TIMEOUT_MS = 20000;
const POLL_HOLD_MS = 15000;
const SUPERSEDED = 'another stream took over the relay (a newer "Cast via relay" click). The relay serves one stream at a time.';

// /health answers with this, so callers (and our own startup check) can tell this relay apart
// from some other server that happens to hold the port.
const HEALTH = `stream-sniffer-relay ${crypto.randomBytes(4).toString('hex')}`;

/** id -> { url, hosts: Set, info, stats, queue, waiters, pending, bridgeSeenAt } */
const streams = new Map();

function lanAddress() {
  const ifaces = os.networkInterfaces();
  const order = ['en0', 'en1', ...Object.keys(ifaces)];
  for (const name of order) {
    const v4 = (ifaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  throw new Error('No LAN IPv4 address found. Join a network or set RELAY_HOST.');
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

// /s/<id>/r/<base64url upstream>/<filename>. The trailing filename (e.g. seg1.ts) is only a
// hint for players that sniff by extension; the base64 part is what's used.
function relayPath(id, upstream) {
  const name = (new URL(upstream).pathname.split('/').pop() || 'x').replace(/[^\w.-]/g, '_') || 'x';
  return `/s/${id}/r/${b64(upstream)}/${name}`;
}

function rewritePlaylist(text, base, id, stream) {
  const proxied = (uri) => {
    const abs = new URL(uri, base).href;
    stream.hosts.add(new URL(abs).host);
    return relayPath(id, abs);
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(u)}"`);
      return proxied(line.trim());
    })
    .join('\n');
}

function recordError(id, stream, err) {
  stream.stats.errors.push({ at: new Date().toISOString(), error: err });
  stream.stats.errors.splice(0, stream.stats.errors.length - 10);
  console.error(`[relay] ${id}: ${err}`);
}

// Hands a URL to the player tab and waits for it to come back with the response.
function bridgeFetch(stream, url) {
  return new Promise((resolve, reject) => {
    const job = { id: crypto.randomBytes(6).toString('hex'), url };
    const timer = setTimeout(() => {
      stream.pending.delete(job.id);
      const i = stream.queue.indexOf(job);
      if (i >= 0) stream.queue.splice(i, 1);
      reject(new Error(`the player tab didn't fetch ${url} within ${BRIDGE_TIMEOUT_MS / 1000}s. Keep the Stream Sniffer player tab open; it does the fetching for the relay.`));
    }, BRIDGE_TIMEOUT_MS);
    stream.pending.set(job.id, { resolve, timer });
    const waiter = stream.waiters.shift();
    if (waiter) waiter(job);
    else stream.queue.push(job);
  });
}

// Fetches one upstream resource through the player tab. Playlists come back rewritten.
async function fetchUpstream(id, stream, upstream) {
  let res;
  try {
    res = await bridgeFetch(stream, upstream);
  } catch (err) {
    recordError(id, stream, err.message);
    return { status: 504, error: err.message };
  }
  if (res.error) {
    const err = `Chrome couldn't fetch ${upstream}: ${res.error}`;
    recordError(id, stream, err);
    return { status: 502, error: err };
  }
  stream.hosts.add(new URL(res.finalUrl).host); // redirects may land on another host
  if (res.status < 200 || res.status > 299) {
    const err = `CDN returned HTTP ${res.status} for ${upstream}`;
    recordError(id, stream, err);
    return { status: res.status, error: err };
  }
  const { body, type } = res;
  const isPlaylist = /mpegurl/i.test(type) || body.subarray(0, 7).toString() === '#EXTM3U';
  if (isPlaylist) {
    const text = rewritePlaylist(body.toString('utf8'), res.finalUrl, id, stream);
    return { status: 200, isPlaylist, raw: body.toString('utf8'), body: Buffer.from(text), type: 'application/vnd.apple.mpegurl' };
  }
  // Some CDNs disguise TS segments as images; tell the receiver what they really are.
  const realType = /^image\//i.test(type) ? 'video/mp2t' : type || 'application/octet-stream';
  return { status: 200, isPlaylist, body, type: realType };
}

// Looks at the playlist up front so the cast page can tell the receiver the stream type, and so
// a CDN rejection shows up now, in the player, instead of as a silent black screen on the TV.
async function probe(id, stream) {
  const top = await fetchUpstream(id, stream, stream.url);
  if (top.error) return { error: top.error };
  if (!top.isPlaylist) return { error: `${stream.url} did not return an HLS playlist` };
  let media = top.raw;
  let mediaBase = stream.url;
  if (/#EXT-X-STREAM-INF/.test(media)) {
    const variant = media.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
    mediaBase = new URL(variant.trim(), stream.url).href;
    const v = await fetchUpstream(id, stream, mediaBase);
    if (v.error) return { error: v.error };
    media = v.raw;
  }
  const firstSeg = media.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  return {
    info: {
      live: !/#EXT-X-ENDLIST/.test(media),
      segmentFormat: /#EXT-X-MAP/.test(media) || /\.(m4s|mp4)(\?|$)/i.test(firstSeg) ? 'fmp4' : 'ts',
    },
  };
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const readJson = async (req) => JSON.parse((await readBody(req)).toString('utf8'));

// GET /api/streams/<id>/next — the player tab's long-poll for the next URL to fetch.
function nextJob(req, res, stream) {
  if (stream.superseded) return sendJson(res, 410, { error: SUPERSEDED });
  stream.bridgeSeenAt = Date.now();
  const queued = stream.queue.shift();
  if (queued) return sendJson(res, 200, queued);
  let done = false;
  const waiter = (job) => {
    done = true;
    clearTimeout(hold);
    if (job === null) return sendJson(res, 410, { error: SUPERSEDED });
    if (res.destroyed) {
      // The tab went away between polls; give the job to the next poll instead.
      stream.queue.unshift(job);
      return;
    }
    sendJson(res, 200, job);
  };
  const hold = setTimeout(() => {
    done = true;
    stream.waiters.splice(stream.waiters.indexOf(waiter), 1);
    send(res, 204, '');
  }, POLL_HOLD_MS);
  req.on('close', () => {
    if (done) return;
    clearTimeout(hold);
    const i = stream.waiters.indexOf(waiter);
    if (i >= 0) stream.waiters.splice(i, 1);
  });
  stream.waiters.push(waiter);
}

// POST /api/streams/<id>/result/<jobId> — the player tab delivering what Chrome fetched.
async function jobResult(req, res, stream, jobId) {
  const body = await readBody(req);
  const p = stream.pending.get(jobId);
  if (!p) return sendJson(res, 410, { error: 'job expired (the TV stopped waiting for it)' });
  stream.pending.delete(jobId);
  clearTimeout(p.timer);
  const h = (name) => decodeURIComponent(req.headers[name] || '');
  if (req.headers['x-upstream-error']) p.resolve({ error: h('x-upstream-error') });
  else {
    p.resolve({
      status: Number(req.headers['x-upstream-status']),
      type: h('x-upstream-type'),
      finalUrl: h('x-upstream-url'),
      body,
    });
  }
  sendJson(res, 200, { ok: true });
}

const castInfo = (id, s) => ({
  id,
  url: s.url,
  mediaUrl: LAN_BASE + relayPath(id, s.url),
  castPageUrl: `http://localhost:${PORT}/cast/${id}`,
  info: s.info,
});

async function handle(req, res) {
  const url = new URL(req.url, LAN_BASE);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': '*' });
  }
  if (url.pathname === '/health') return send(res, 200, HEALTH);

  // Registering and inspecting streams is for this Mac only; the LAN only gets the media.
  if (parts[0] === 'api' || parts[0] === 'cast') {
    if (!isLoopback(req)) return send(res, 403, 'loopback only');
  }

  if (req.method === 'POST' && url.pathname === '/api/streams') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: `bad JSON: ${err.message}` });
    }
    if (!/^https?:\/\//.test(body.url || '')) return sendJson(res, 400, { error: 'url must be http(s)' });
    // One stream at a time: retire the others so their player tabs stop polling (each held
    // poll is one of Chrome's 6 connections to localhost:PORT).
    for (const [oldId, old] of streams) {
      if (old.superseded) continue;
      old.superseded = true;
      for (const w of old.waiters.splice(0)) w(null);
      console.log(`[relay] ${oldId}: superseded`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    streams.set(id, {
      superseded: false,
      url: body.url,
      hosts: new Set([new URL(body.url).host]),
      info: null,
      stats: { requests: 0, lastRequestAt: null, errors: [], recent: [] },
      queue: [],
      waiters: [],
      pending: new Map(),
      bridgeSeenAt: null,
    });
    console.log(`[relay] ${id}: registered ${body.url}; waiting for the player tab to probe it`);
    return sendJson(res, 200, { id });
  }

  if (req.method === 'GET' && url.pathname === '/api/streams') {
    return sendJson(res, 200, [...streams].map(([id, s]) => ({ id, url: s.url, superseded: s.superseded, requests: s.stats.requests })));
  }

  // /api/streams/<id>[/<action>[/<jobId>]]
  if (parts[0] === 'api' && parts[1] === 'streams') {
    const [, , id, action, jobId] = parts;
    const s = streams.get(id);
    if (!s) return sendJson(res, 404, { error: 'unknown stream (the relay may have restarted)' });
    if (req.method === 'GET' && !action) {
      const seen = s.bridgeSeenAt ? Math.round((Date.now() - s.bridgeSeenAt) / 1000) : null;
      return sendJson(res, 200, { ...castInfo(id, s), stats: s.stats, bridgeSeenSecondsAgo: seen });
    }
    if (req.method === 'GET' && action === 'next') return nextJob(req, res, s);
    if (req.method === 'POST' && action === 'result' && jobId) return jobResult(req, res, s, jobId);
    if (req.method === 'POST' && action === 'probe') {
      const result = await probe(id, s);
      if (result.error) return sendJson(res, 502, { error: result.error });
      s.info = result.info;
      console.log(`[relay] ${id}: probe ok (${result.info.live ? 'live' : 'VOD'}, ${result.info.segmentFormat})`);
      return sendJson(res, 200, castInfo(id, s));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  const stream = streams.get(parts[1]);

  if (parts[0] === 'cast') {
    if (!stream?.info) return send(res, 404, 'unknown stream (the relay may have restarted)');
    return send(res, 200, fs.readFileSync(CAST_HTML_PATH, 'utf8'), { 'content-type': 'text/html; charset=utf-8' });
  }

  if (parts[0] === 's' && parts[2] === 'r' && parts[3]) {
    if (!stream?.info) return send(res, 404, 'unknown stream (the relay may have restarted)');
    if (stream.superseded) return send(res, 410, SUPERSEDED);
    let upstream;
    try {
      upstream = unb64(parts[3]);
      if (!/^https?:\/\//.test(upstream)) throw new Error('not http(s)');
    } catch {
      return send(res, 400, 'bad upstream reference');
    }
    // Only fetch hosts this stream's own playlists pointed at, so the relay can't be used
    // as an open proxy by anything else on the network.
    if (!stream.hosts.has(new URL(upstream).host)) return send(res, 403, 'host not part of this stream');
    stream.stats.requests++;
    stream.stats.lastRequestAt = new Date().toISOString();
    const started = Date.now();
    const r = await fetchUpstream(parts[1], stream, upstream);
    // Per-request timing: shows whether the TV is starved (slow fetches) or fed junk.
    stream.stats.recent.push({
      at: new Date().toISOString(),
      file: new URL(upstream).pathname.split('/').pop(),
      status: r.error ? r.status : 200,
      bytes: r.body?.length ?? 0,
      ms: Date.now() - started,
      type: r.type,
      head: r.body && !r.isPlaylist ? r.body.subarray(0, 8).toString('hex') : undefined,
    });
    stream.stats.recent.splice(0, stream.stats.recent.length - 30);
    if (r.error) return send(res, r.status, r.error, { 'content-type': 'text/plain' });
    return send(res, 200, r.body, { 'content-type': r.type });
  }

  send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[relay] ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) send(res, 500, `relay error: ${err.message}`);
    else res.destroy(err);
  });
});
server.on('error', (err) => {
  console.error(`[relay] server error: ${err.message}`);
  process.exit(1);
});
// '::' accepts IPv4 and IPv6, so both localhost (::1) and the LAN address work.
server.listen(PORT, '::', async () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] TV-facing address: ${LAN_BASE}${process.env.RELAY_HOST ? ' (from RELAY_HOST)' : ' (auto-detected; set RELAY_HOST to override)'}`);
  // Another process bound to just 127.0.0.1 on this port would quietly win "localhost"
  // requests from the extension. Make sure every address we rely on reaches us.
  for (const base of [`http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`, LAN_BASE]) {
    let got;
    try {
      got = await (await fetch(`${base}/health`)).text();
    } catch (err) {
      got = `unreachable (${err.cause?.code || err.message})`;
    }
    if (got !== HEALTH) {
      console.error(`[relay] ${base} is not reaching this relay (got: ${got.slice(0, 80)}). Another process may hold port ${PORT}; pick another with RELAY_PORT.`);
      process.exit(1);
    }
  }
  console.log('[relay] ready');
});
