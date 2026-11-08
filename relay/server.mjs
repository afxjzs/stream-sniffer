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
import zlib from 'node:zlib';
import '../extension/disguise.js'; // defines globalThis.StreamSnifferDisguise (shared with the player)
import { firstTimestamp, shiftTimestamps, wrapTimestamp, TICKS_PER_SECOND } from './ts-time.mjs';

const nodeCodecs = { inflate: async (b) => zlib.inflateSync(b), gunzip: async (b) => zlib.gunzipSync(b) };

const PORT = Number(process.env.RELAY_PORT || 8788);
const LAN_HOST = process.env.RELAY_HOST || lanAddress();
const LAN_BASE = `http://${LAN_HOST}:${PORT}`;
// Read on every request, so edits to the cast page apply without restarting the relay.
const CAST_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cast.html');

// How long the TV's request waits for the player tab to deliver, and how long one long-poll
// from the player tab is held open when there is nothing to fetch.
const BRIDGE_TIMEOUT_MS = 20000;
const POLL_HOLD_MS = 15000;
const SUPERSEDED = 'another stream took over the relay (a newer "Start casting" click). The relay serves one stream at a time.';

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

// /s/<id>/r<src>/<base64url upstream>/<filename>. <src> is which of the cast's streams it
// belongs to (empty for the first), so the player tab fetches it with that stream's headers.
// The trailing filename (e.g. seg1.ts) is only a hint for players that sniff by extension; the
// base64 part is what's used.
// Extensions ffmpeg's HLS reader accepts for a segment (its allowed_segment_extensions default,
// ffmpeg 8.1). Players built on ffmpeg, like Jellyfin's Live TV, refuse any other name, and some
// sites name segments like images (….image, ….png). Such a name gets `.ts` added, or `.m4s` in
// an fMP4 playlist, which is what is inside: the relay hands disguised segments over as MPEG-TS.
const MEDIA_EXTS = new Set('3gp aac avi ac3 eac3 flac mkv m3u8 m4a m4s m4v mpg mov mp2 mp3 mp4 mpeg mpegts ogg ogv oga ts vob vtt wav webvtt cmfv cmfa ec3 fmp4'.split(' '));
function relayPath(id, upstream, src = 0, otherExt = 'ts') {
  let name = (new URL(upstream).pathname.split('/').pop() || 'x').replace(/[^\w.-]/g, '_') || 'x';
  if (!MEDIA_EXTS.has(name.split('.').pop().toLowerCase())) name += `.${otherExt}`;
  return `/s/${id}/r${src || ''}/${b64(upstream)}/${name}`;
}

function rewritePlaylist(text, base, id, stream) {
  // A master playlist lists playlists; a media playlist lists segments, fMP4 if it has a MAP.
  const otherExt = /#EXT-X-STREAM-INF/.test(text) ? 'm3u8' : /#EXT-X-MAP/.test(text) ? 'm4s' : 'ts';
  const proxied = (uri) => {
    const abs = new URL(uri, base).href;
    stream.hosts.add(new URL(abs).host);
    return relayPath(id, abs, 0, otherExt);
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

// Why a replaced cast's unfinished fetches end. Its own "superseded" log line already says how
// many were dropped, so failures that only repeat this aren't printed again for each fetch.
const DROPPED = 'dropped: this cast was replaced by a newer one';
function recordError(id, stream, err) {
  if (stream.superseded && String(err).includes(DROPPED)) return;
  stream.stats.errors.push({ at: new Date().toISOString(), error: err });
  stream.stats.errors.splice(0, stream.stats.errors.length - 10);
  console.error(`[relay] ${id}: ${err}`);
}

// Hands a URL to the player tab and waits for it to come back with the response. src says
// which of the cast's streams it belongs to, so the tab sends that stream's headers.
//
// A stream server sometimes never answers one request (seen Nov 2026: a playlist request hung
// for 20 s while the TV ran dry). So if no answer has come back after each of ASK_AGAIN_MS, the
// tab is asked again, and the first answer wins.
const ASK_AGAIN_MS = [4000, 9000];
function bridgeFetch(stream, url, src = 0) {
  return new Promise((resolve, reject) => {
    // A replaced cast's player tab has stopped polling for it; nobody would answer.
    if (stream.superseded) return reject(new Error(`${DROPPED} (${url})`));
    const jobs = [];
    const timers = [];
    let settled = false;
    // Ends this fetch now when its cast is replaced (see POST /api/streams).
    const drop = () => {
      if (settled) return;
      finish();
      reject(new Error(`${DROPPED} (${url})`));
    };
    stream.inflight.add(drop);
    const finish = () => {
      settled = true;
      stream.inflight.delete(drop);
      timers.forEach(clearTimeout);
      for (const job of jobs) {
        stream.pending.delete(job.id);
        const i = stream.queue.indexOf(job);
        if (i >= 0) stream.queue.splice(i, 1);
      }
    };
    const ask = () => {
      const job = { id: crypto.randomBytes(6).toString('hex'), url, src };
      jobs.push(job);
      stream.pending.set(job.id, {
        resolve: (result) => {
          if (settled) return;
          finish();
          resolve(result);
        },
      });
      const waiter = stream.waiters.shift();
      if (waiter) waiter(job);
      else stream.queue.push(job);
    };
    ask();
    for (const ms of ASK_AGAIN_MS) {
      timers.push(
        setTimeout(() => {
          if (settled) return;
          console.log(`[relay] no answer for ${new URL(url).pathname.split('/').pop()} after ${ms / 1000} s; asking the player tab again`);
          ask();
        }, ms)
      );
    }
    timers.push(
      setTimeout(() => {
        if (settled) return;
        finish();
        reject(new Error(`the player tab didn't fetch ${url} within ${BRIDGE_TIMEOUT_MS / 1000}s (asked ${jobs.length} times). Keep the Stream Sniffer player tab open; it does the fetching for the relay.`));
      }, BRIDGE_TIMEOUT_MS)
    );
  });
}

// Fetches one upstream resource through the player tab. Playlists come back rewritten.
async function fetchUpstream(id, stream, upstream, src = 0) {
  let res;
  try {
    res = await bridgeFetch(stream, upstream, src);
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
    return { status: 200, isPlaylist, raw: body.toString('utf8'), finalUrl: res.finalUrl, body: Buffer.from(text), type: 'application/vnd.apple.mpegurl' };
  }
  // Some CDNs disguise TS segments as images (see extension/disguise.js). The Chromecast can't
  // decode those the way the site's own player does, so hand it plain MPEG-TS.
  let ts;
  try {
    ts = await StreamSnifferDisguise.decodeDisguisedSegment(body, nodeCodecs);
  } catch (err) {
    const msg = `couldn't decode ${upstream}: ${err.message}`;
    recordError(id, stream, msg);
    return { status: 502, error: msg };
  }
  if (ts) {
    if (!stream.unwrapNoted) {
      stream.unwrapNoted = true;
      console.log(`[relay] ${id}: segments are disguised as images; decoding them for the TV`);
    }
    return { status: 200, isPlaylist, body: Buffer.from(ts), type: 'video/mp2t' };
  }
  // An image we can't unwrap must not reach the TV labeled as video: it would download every
  // segment, decode none, and buffer forever with no error anywhere.
  const kind = StreamSnifferDisguise.imageKind(body);
  const looksLikeTs = body[0] === 0x47 && (body.length <= 188 || body[188] === 0x47);
  if (!looksLikeTs && (kind || /^image\//i.test(type))) {
    const what = kind ? `a ${kind} image` : `served as ${type}`;
    const msg = `${upstream} is ${what}, not video, in a disguise format Stream Sniffer can't decode (starts with ${body.subarray(0, 8).toString('hex')})`;
    recordError(id, stream, msg);
    return { status: 502, error: msg };
  }
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
  if (!firstSeg) return { error: `${mediaBase} lists no segments` };
  // A segment the TV can't use (rejected, or wrapped in a format we can't decode) shows up
  // here, in the player, instead of as endless buffering on the TV.
  const seg = await fetchUpstream(id, stream, new URL(firstSeg.trim(), mediaBase).href);
  if (seg.error) return { error: seg.error };
  return {
    info: {
      live: !/#EXT-X-ENDLIST/.test(media),
      segmentFormat: /#EXT-X-MAP/.test(media) || /\.(m4s|mp4)(\?|$)/i.test(firstSeg) ? 'fmp4' : 'ts',
    },
  };
}

// ---- Swap on TV ----------------------------------------------------------------------------
//
// With two live streams, the relay serves the TV one live playlist that it builds itself: each
// refresh adds the newest segments of whichever stream is active. A swap marks a discontinuity
// and continues from the other stream, starting at its current live window. The inactive
// stream isn't fetched at all. Only live MPEG-TS streams without encryption qualify; anything
// else is refused at the probe, with the reason.

// Segments listed to the TV; old ones scroll off, as in any live playlist. RELAY_CHANNEL_WINDOW
// overrides it (the E2E test uses a short one); startup prints it when overridden.
const CHANNEL_WINDOW = Number(process.env.RELAY_CHANNEL_WINDOW || 12);
if (!Number.isInteger(CHANNEL_WINDOW) || CHANNEL_WINDOW < 3) {
  throw new Error(`RELAY_CHANNEL_WINDOW must be a whole number of at least 3 (got ${JSON.stringify(process.env.RELAY_CHANNEL_WINDOW)})`);
}

// Seconds of video the relay keeps in reserve: each new segment is listed to the TV this long
// after the relay first sees it. A source that pauses for less than this never starves the TV,
// which otherwise plays a second or two behind the newest segment. A stream whose playlist is
// too short gets less (the TV is always given at least two segments); the cast page shows the
// amount in use. RELAY_HOLD_SECONDS overrides it; startup prints it when overridden.
const HOLD_SECONDS = Number(process.env.RELAY_HOLD_SECONDS ?? 12);
if (!Number.isFinite(HOLD_SECONDS) || HOLD_SECONDS < 0) {
  throw new Error(`RELAY_HOLD_SECONDS must be a number of seconds, 0 or more (got ${JSON.stringify(process.env.RELAY_HOLD_SECONDS)})`);
}

// How long the TV's playlist request waits for a refresh from the source before it gets what
// is already listed.
const REFRESH_WAIT_MS = 1000;

// The parts of a media playlist the channel needs. Throws for features it can't carry over.
function parseMediaPlaylist(text, base) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('not an HLS playlist');
  const pl = { seq: 0, discSeq: 0, target: 0, ended: false, segs: [] };
  let dur = null;
  let disc = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const value = line.slice(line.indexOf(':') + 1);
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.seq = Number(value);
    else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) pl.discSeq = Number(value);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) pl.target = Number(value);
    else if (line.startsWith('#EXTINF:')) dur = parseFloat(value);
    else if (line === '#EXT-X-DISCONTINUITY') disc = true;
    else if (line === '#EXT-X-ENDLIST') pl.ended = true;
    else if (line.startsWith('#EXT-X-MAP')) throw new Error('uses fMP4 segments, which Swap on TV does not handle yet');
    else if (line.startsWith('#EXT-X-BYTERANGE')) throw new Error('uses byte-range segments, which Swap on TV does not handle yet');
    else if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) throw new Error('is encrypted, which Swap on TV does not handle yet');
    else if (!line.startsWith('#')) {
      if (dur == null || Number.isNaN(dur)) throw new Error(`segment ${line} has no #EXTINF duration`);
      pl.segs.push({ seq: pl.seq + pl.segs.length, uri: new URL(line, base).href, dur, disc });
      dur = null;
      disc = false;
    }
  }
  if (!pl.segs.length) throw new Error('lists no segments');
  return pl;
}

// The media playlist for a stream: the URL itself, or the highest-bandwidth variant of a master.
async function resolveMedia(id, stream, src) {
  const s = stream.sources[src];
  const top = await fetchUpstream(id, stream, s.url, src);
  if (top.error) return { error: top.error };
  if (!top.isPlaylist) return { error: `${s.url} did not return an HLS playlist` };
  if (!/#EXT-X-STREAM-INF/.test(top.raw)) return { mediaUrl: top.finalUrl || s.url, raw: top.raw };
  if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(top.raw)) {
    return { unsupported: 'has its sound in a separate track, which Swap on TV does not handle yet' };
  }
  const lines = top.raw.split(/\r?\n/);
  let best = null;
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const bw = Number(line.match(/[:,]BANDWIDTH=(\d+)/)?.[1] ?? 0);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    if (uri && (!best || bw > best.bw)) best = { bw, url: new URL(uri.trim(), top.finalUrl || s.url).href };
  });
  if (!best) return { unsupported: 'is a master playlist with no variants' };
  const v = await fetchUpstream(id, stream, best.url, src);
  if (v.error) return { error: v.error };
  if (!v.isPlaylist) return { error: `${best.url} did not return an HLS playlist` };
  return { mediaUrl: v.finalUrl || best.url, raw: v.raw };
}

// Checks both streams before casting: each must be a live MPEG-TS playlist whose first segment
// the TV can play. A failure names the stream, so the player can say which one to remove.
async function probeChannel(id, stream) {
  for (const [src, s] of stream.sources.entries()) {
    const fail = (why) => ({ why, error: `Swap on TV can't use "${s.label}": it ${why}. Remove it (× on the small picture) to cast just the other one.` });
    const media = await resolveMedia(id, stream, src);
    if (media.unsupported) return fail(media.unsupported);
    if (media.error) return fail(`failed: ${media.error}`);
    let pl;
    try {
      pl = parseMediaPlaylist(media.raw, media.mediaUrl);
    } catch (err) {
      return fail(err.message);
    }
    if (pl.ended) return fail('is on-demand, not live');
    for (const seg of pl.segs) stream.hosts.add(new URL(seg.uri).host);
    const first = await fetchUpstream(id, stream, pl.segs[0].uri, src);
    if (first.error) return fail(`failed: ${first.error}`);
    s.mediaUrl = media.mediaUrl;
    console.log(`[relay] ${id}: stream ${src + 1} is live MPEG-TS, ok to relist: ${s.label} (${media.mediaUrl})`);
  }
  return { info: { live: true, segmentFormat: 'ts', channel: true } };
}

function newChannel() {
  return {
    active: 0,
    entries: [], // { seq, src, uri, dur, disc } as listed to the TV
    nextSeq: 0,
    discSeq: 0, // discontinuities that have scrolled off the top
    target: 0,
    lastSeq: [null, null], // per stream: the newest of its segments already added
    pendingSwitch: false,
    switch: null, // the latest swap: { n, to, label, at, firstSeq, tvSawAt }
    refreshing: null,
    refreshedAt: 0,
    joining: true, // the next refresh is the first from this stream (at the start, or after a swap)
    nextListAt: 0, // when the next new segment may be listed to the TV (see refreshChannel)
    lastRun: null, // the run (see addToRun) its newest segment belongs to
    runOf: new Map(), // upstream segment URL -> its run
  };
}

// The TV's clock. A run is a stretch of segments from one stream with no break in between; at
// a break (a swap, a gap at the source, or a new cast) the next stream's timestamps are
// unrelated, often hours apart, and players that pace themselves by timestamps (Jellyfin's
// ffmpeg reads with -re) wait out a jump forward and freeze. So each run's segments are shifted
// to start where the run before it ended, as listed to the TV. One clock across casts, since
// /now.m3u8 carries a TV app from one cast to the next.
const RUN_GAP = 0.1 * TICKS_PER_SECOND; // a little air at each break, rather than any overlap
let lastRun = null; // the newest run of any cast
function addToRun(ch, entry) {
  let run = ch.lastRun;
  if (!run || entry.disc) {
    // Where the last run ended: its segments that were listed. Its reserve, never listed (cut
    // by a swap or a new cast), never reached the TV.
    const prevEnd = lastRun
      ? lastRun.startOut + lastRun.entries.filter((e) => e.listAt <= Date.now()).reduce((t, e) => t + e.dur * TICKS_PER_SECOND, 0) + RUN_GAP
      : 10 * TICKS_PER_SECOND;
    run = { startOut: wrapTimestamp(Math.round(prevEnd)), entries: [], offset: null };
    ch.lastRun = lastRun = run;
  }
  run.entries.push(entry);
  ch.runOf.set(entry.uri, run);
}

// The reserve only works if the relay keeps up with the source. A TV that asks rarely (Jellyfin's
// ffmpeg reloads the playlist only when it runs low) would otherwise leave the source unread
// while the reserve is listed out, so a pause at the source then reaches the TV. So a live cast
// is refreshed on a timer, whatever the TV does (refreshChannel itself limits how often). Its
// errors are printed once each, not every second.
function keepRefreshing(id, stream) {
  clearInterval(stream.refreshTimer);
  let lastError = null;
  stream.refreshTimer = setInterval(() => {
    if (stream.superseded) return clearInterval(stream.refreshTimer);
    refreshChannel(id, stream).then(
      () => (lastError = null),
      (err) => {
        if (err.message !== lastError) recordError(id, stream, err.message);
        lastError = err.message;
      }
    );
  }, 1000);
}

// A channel segment as the TV gets it: shifted onto the TV's clock. The shift is fixed by the
// run's first segment, so every segment of a run moves by the same amount.
async function onTvClock(id, stream, run, segment) {
  run.offset ??= (async () => {
    const first = run.entries[0];
    const r = await cachedFetch(id, stream, first.uri, first.src);
    if (r.error) throw new Error(`can't line up the TV's clock: the first segment of this stretch failed (${r.error})`);
    const t = firstTimestamp(r.body);
    if (t == null) throw new Error(`can't line up the TV's clock: ${first.uri} has no timestamps`);
    return wrapTimestamp(run.startOut - t);
  })().catch((err) => {
    run.offset = null; // try again on the next request rather than failing every segment for good
    throw err;
  });
  return shiftTimestamps(segment, await run.offset);
}

// Adds the active stream's new segments. At most one refresh at a time, and none more often
// than every half target duration, however many requests the TV makes.
function refreshChannel(id, stream) {
  const ch = stream.channel;
  if (ch.refreshing) return ch.refreshing;
  if (ch.entries.length && Date.now() - ch.refreshedAt < ch.target * 500) return Promise.resolve();
  ch.refreshing = (async () => {
    const src = ch.active;
    const s = stream.sources[src];
    const r = await fetchUpstream(id, stream, s.mediaUrl, src);
    if (r.error) throw new Error(`refreshing "${s.label}": ${r.error}`);
    if (!r.isPlaylist) throw new Error(`refreshing "${s.label}": ${s.mediaUrl} did not return a playlist`);
    // Swapped while this was in flight: this stream's segments no longer belong on the TV, and
    // the swap's own refresh adds the other stream's.
    if (ch.active !== src) return;
    const pl = parseMediaPlaylist(r.raw, r.finalUrl || s.mediaUrl);
    if (pl.ended) throw new Error(`"${s.label}" has ended (its playlist now has #EXT-X-ENDLIST)`);
    ch.target = Math.max(ch.target, pl.target);
    const last = ch.lastSeq[src];
    const fresh = (last == null ? pl.segs : pl.segs.filter((x) => x.seq > last)).map((x) => ({ ...x }));
    if (fresh.length) {
      // Segments we never saw (a long gap between refreshes) break the timeline like a swap does.
      if (last != null && fresh[0].seq > last + 1) fresh[0].disc = true;
      if (ch.pendingSwitch) {
        fresh[0].disc = ch.entries.length > 0;
        ch.pendingSwitch = false;
        ch.switch.firstSeq = ch.nextSeq;
      }
      // When each segment is listed to the TV (listAt). The relay paces them: each one when the
      // one before would have finished playing, never before it arrives, and never more than
      // HOLD_SECONDS after it arrives. While the source pauses, the reserve (segments not yet
      // listed) keeps the TV fed at the normal pace and shrinks; the burst that usually follows
      // a pause refills it.
      const now = Date.now();
      let held = 0; // joining: how many of the newest segments start in reserve
      const joined = ch.joining;
      if (ch.joining) {
        // The TV always gets at least two segments to start with.
        let heldSeconds = 0;
        for (let i = fresh.length - 1; i >= 2 && heldSeconds + fresh[i].dur <= HOLD_SECONDS; i--) {
          held++;
          heldSeconds += fresh[i].dur;
        }
        ch.nextListAt = now;
        ch.joining = false;
        const total = fresh.reduce((t, x) => t + x.dur, 0);
        console.log(`[relay] ${id}: starting "${s.label}" with ${heldSeconds.toFixed(1)} s in reserve (keeps up to ${HOLD_SECONDS} s; its playlist lists ${total.toFixed(1)} s)`);
      }
      for (const [i, x] of fresh.entries()) {
        stream.hosts.add(new URL(x.uri).host);
        // Joining: the segments not held start out listed; the held ones follow them, paced.
        const listAt = joined
          ? i < fresh.length - held
            ? now
            : ch.nextListAt
          : Math.max(now, Math.min(ch.nextListAt, now + HOLD_SECONDS * 1000));
        ch.nextListAt = listAt + x.dur * 1000;
        const entry = { seq: ch.nextSeq++, src, uri: x.uri, dur: x.dur, disc: x.disc, listAt };
        addToRun(ch, entry);
        ch.entries.push(entry);
        // Fetch reserved segments now, so the TV's request for each is answered from memory.
        if (listAt > now) cachedFetch(id, stream, x.uri, src).catch((err) => recordError(id, stream, `fetching a reserved segment early: ${err.message}`));
      }
      ch.lastSeq[src] = pl.segs.at(-1).seq;
    }
    ch.refreshedAt = Date.now();
  })().finally(() => {
    ch.refreshing = null;
  });
  return ch.refreshing;
}

// The segments the TV may see now: those whose time in reserve is up, newest CHANNEL_WINDOW.
// Older ones scroll off for good.
function listedEntries(ch) {
  const now = Date.now();
  let listed = ch.entries.filter((e) => e.listAt <= now).length;
  for (; listed > CHANNEL_WINDOW; listed--) if (ch.entries.shift().disc) ch.discSeq++;
  return ch.entries.slice(0, listed);
}

// view renumbers the playlist for /now.m3u8 (see nowView): segment numbers shifted by seqBase,
// discontinuity numbers by discBase, and a discontinuity added before segment markSeq.
function channelPlaylist(id, ch, view = null) {
  const entries = listedEntries(ch);
  const { seqBase = 0, discBase = 0, markSeq = null } = view ?? {};
  const marked = (e) => e.disc || e.seq === markSeq;
  // The added discontinuity counts in DISCONTINUITY-SEQUENCE once its segment has scrolled off.
  const markGone = markSeq != null && entries[0].seq > markSeq ? 1 : 0;
  const target = Math.max(ch.target, ...entries.map((e) => Math.ceil(e.dur)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${entries[0].seq + seqBase}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${ch.discSeq + discBase + markGone}`,
  ];
  for (const e of entries) {
    if (marked(e)) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${e.dur.toFixed(3)},`, relayPath(id, e.uri, e.src));
  }
  if (view) {
    // Remembered so the next cast on /now.m3u8 can continue after these numbers.
    const discs = entries.filter(marked).length;
    view.lastSeq = entries.at(-1).seq + seqBase;
    view.lastDisc = ch.discSeq + discBase + markGone + discs;
  }
  return lines.join('\n') + '\n';
}

// /now.m3u8 is one address that TV apps keep open across casts. Players built on ffmpeg (Jellyfin)
// ignore segments numbered below ones they've seen, so a new cast's numbers must continue where
// the last cast's stopped, after a discontinuity (its timestamps start over). One view per cast;
// the latest one served is what the next cast continues from.
const nowViews = new Map(); // cast id -> view
let lastNowView = null;
function nowView(id, ch) {
  let view = nowViews.get(id);
  if (!view) {
    const first = listedEntries(ch)[0];
    view = lastNowView
      ? { seqBase: lastNowView.lastSeq + 1 - first.seq, discBase: lastNowView.lastDisc - ch.discSeq, markSeq: first.seq }
      : { seqBase: 0, discBase: 0, markSeq: null };
    nowViews.set(id, view);
  }
  lastNowView = view;
  return view;
}

// render: builds the playlist body from the channel (default: the cast's own numbering).
async function serveChannel(id, stream, res, render = (ch) => channelPlaylist(id, ch)) {
  const ch = stream.channel;
  const started = Date.now();
  // A slow refresh mustn't hold up the TV, which needs only what is already listed: wait at
  // most REFRESH_WAIT_MS, and let the refresh finish (and report any error) on its own. With
  // nothing listed yet, there's nothing to answer with, so wait for it.
  const refresh = refreshChannel(id, stream).then(
    () => null,
    (err) => err
  );
  const listed = () => ch.entries.some((e) => e.listAt <= Date.now());
  const err = listed() ? await Promise.race([refresh, new Promise((r) => setTimeout(() => r('slow'), REFRESH_WAIT_MS))]) : await refresh;
  if (err === 'slow') {
    refresh.then((late) => late && recordError(id, stream, late.message));
  } else if (err) {
    // The TV keeps what it has; the error shows in Relay activity. With nothing at all, fail.
    recordError(id, stream, err.message);
    if (!listed()) return send(res, 502, err.message, { 'content-type': 'text/plain' });
  }
  if (ch.switch && ch.switch.firstSeq != null && !ch.switch.tvSawAt) ch.switch.tvSawAt = new Date().toISOString();
  const body = render(ch);
  recordRequest(stream, { file: 'live.m3u8', status: 200, bytes: body.length, ms: Date.now() - started, type: 'application/vnd.apple.mpegurl' });
  send(res, 200, body, { 'content-type': 'application/vnd.apple.mpegurl' });
}

// POST /api/streams/<id>/switch: swap which stream the TV gets.
function switchChannel(id, stream, res) {
  const ch = stream.channel;
  if (!ch || stream.sources.length < 2) return sendJson(res, 400, { error: 'this cast has one stream; add a second one to the player and cast again to swap' });
  if (!stream.info) return sendJson(res, 409, { error: 'the streams have not been checked yet' });
  // Segments of the old stream still in reserve never reach the TV; the swap takes effect now.
  const listed = listedEntries(ch);
  // They leave their run too, or the TV's clock would count them as played (see addToRun).
  for (const e of ch.entries.slice(listed.length)) {
    const run = ch.runOf.get(e.uri);
    if (run) run.entries = run.entries.filter((x) => x !== e);
    ch.runOf.delete(e.uri);
  }
  ch.entries = listed;
  ch.nextSeq = listed.length ? listed.at(-1).seq + 1 : ch.nextSeq;
  ch.active = 1 - ch.active;
  ch.lastSeq[ch.active] = null; // join the new stream at its live window, not where we left it
  ch.joining = true;
  ch.pendingSwitch = true;
  ch.refreshedAt = 0;
  const label = stream.sources[ch.active].label;
  ch.switch = { n: (ch.switch?.n ?? 0) + 1, to: ch.active, label, at: new Date().toISOString(), firstSeq: null, tvSawAt: null };
  console.log(`[relay] ${id}: swapped the TV to "${label}"`);
  // Fetch the new stream now (after any refresh already in flight), so it's ready when the TV
  // next refreshes.
  (ch.refreshing || Promise.resolve())
    .catch(() => {}) // that refresh's own caller reports its failure
    .then(() => refreshChannel(id, stream))
    .catch((err) => recordError(id, stream, err.message));
  sendJson(res, 200, channelState(stream));
}

function channelState(stream) {
  const ch = stream.channel;
  if (!ch || stream.sources.length < 2) return null; // one stream: nothing to swap
  return { active: ch.active, labels: stream.sources.map((s) => s.label), switch: ch.switch };
}

// What the cast page says about the reserve: the amount in use, or why there is none.
function reserveState(stream) {
  if (stream.channel) {
    const now = Date.now();
    const held = stream.channel.entries.filter((e) => e.listAt > now).reduce((t, e) => t + e.dur, 0);
    return { seconds: held, max: HOLD_SECONDS, started: !stream.channel.joining };
  }
  return { seconds: 0, why: stream.noReserveWhy || 'not set up' };
}

function recordRequest(stream, entry) {
  stream.stats.requests++;
  stream.stats.lastRequestAt = new Date().toISOString();
  stream.stats.recent.push({ at: stream.stats.lastRequestAt, ...entry });
  stream.stats.recent.splice(0, stream.stats.recent.length - 30);
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
  if (!p) return sendJson(res, 410, { error: 'job no longer needed (another try answered first, or the TV stopped waiting)' });
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
  mediaUrl: LAN_BASE + (s.channel ? `/s/${id}/live.m3u8` : relayPath(id, s.url)),
  castPageUrl: `http://localhost:${PORT}/cast/${id}`,
  info: s.info,
  channel: channelState(s),
  reserve: reserveState(s),
});

// A short, fixed address for whatever is casting now, so a TV app (VLC, a Fire TV player) can
// keep one URL instead of typing a new long one for every cast.
const NOW_PATH = '/now.m3u8';
function currentCast() {
  const live = [...streams].filter(([, s]) => !s.superseded);
  return live.length ? live.at(-1) : null;
}

async function handle(req, res) {
  let url = new URL(req.url, LAN_BASE);
  const viaNow = url.pathname === NOW_PATH;
  if (viaNow) {
    const [id, s] = currentCast() ?? [];
    if (!s) return send(res, 404, 'Nothing is casting. Press Start casting in the Stream Sniffer player, then open this address again.');
    if (!s.info) return send(res, 503, 'The cast is still starting (the player tab has not finished checking the stream). Try again in a few seconds.');
    // Serve the cast's own playlist here. Its links are root-relative (/s/<id>/…), so they
    // resolve the same from this address.
    url = new URL(new URL(castInfo(id, s).mediaUrl).pathname, LAN_BASE);
  }
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
    // { url } for one stream, or { sources: [{ url, label }, …] } for Swap on TV (two streams).
    const sources = body.sources ?? [{ url: body.url, label: body.url }];
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 2) {
      return sendJson(res, 400, { error: 'sources must list one or two streams' });
    }
    for (const s of sources) {
      if (!/^https?:\/\//.test(s?.url || '')) return sendJson(res, 400, { error: `stream url must be http(s): ${JSON.stringify(s?.url)}` });
      if (typeof s.label !== 'string' || !s.label) return sendJson(res, 400, { error: `stream ${s.url} needs a label` });
    }
    // One stream at a time: retire the others so their player tabs stop polling (each held
    // poll is one of Chrome's 6 connections to localhost:PORT).
    for (const [oldId, old] of streams) {
      if (old.superseded) continue;
      old.superseded = true;
      clearInterval(old.refreshTimer);
      for (const w of old.waiters.splice(0)) w(null);
      // Its unfinished fetches (e.g. video held back for its TV) would otherwise wait out
      // BRIDGE_TIMEOUT_MS for a tab that has moved on, then report it as a failure.
      const dropped = old.inflight.size;
      for (const drop of [...old.inflight]) drop();
      old.queue.length = 0;
      console.log(`[relay] ${oldId}: superseded${dropped ? `; dropped ${dropped} fetch${dropped === 1 ? '' : 'es'} it still had waiting` : ''}`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    streams.set(id, {
      superseded: false,
      url: sources[0].url,
      sources: sources.map((s) => ({ url: s.url, label: s.label, mediaUrl: null })),
      channel: newChannel(), // one stream too: it gets the reserve, unless it turns out not to fit (see probe)
      hosts: new Set(sources.map((s) => new URL(s.url).host)),
      info: null,
      stats: { requests: 0, lastRequestAt: null, errors: [], recent: [] },
      queue: [],
      waiters: [],
      pending: new Map(),
      inflight: new Set(), // drop() for each unfinished bridgeFetch

      bridgeSeenAt: null,
    });
    const what = sources.length > 1 ? `a Swap on TV channel: ${sources.map((s) => `"${s.label}"`).join(' and ')}` : sources[0].url;
    console.log(`[relay] ${id}: registered ${what}; waiting for the player tab to probe it`);
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
      let result = await (s.channel ? probeChannel(id, s) : probe(id, s));
      if (result.error && s.sources.length === 1 && s.channel) {
        // One stream that can't be relisted with a reserve (on-demand, fMP4, separate audio,
        // encrypted…): pass its playlists through as they are, and say so.
        s.channel = null;
        s.noReserveWhy = `this stream ${result.why || result.error}`;
        console.log(`[relay] ${id}: no reserve for this stream (${s.noReserveWhy}); passing its playlists through unchanged`);
        result = await probe(id, s);
      }
      if (result.error) {
        recordError(id, s, result.error);
        return sendJson(res, 502, { error: result.error });
      }
      s.info = result.info;
      const mode = !s.channel ? 'playlists passed through, no reserve' : s.sources.length > 1 ? 'Swap on TV channel' : 'relisted with a reserve';
      console.log(`[relay] ${id}: probe ok (${result.info.live ? 'live' : 'VOD'}, ${result.info.segmentFormat}, ${mode})`);
      if (s.channel) keepRefreshing(id, s);
      return sendJson(res, 200, castInfo(id, s));
    }
    if (req.method === 'POST' && action === 'switch') return switchChannel(id, s, res);
    return sendJson(res, 404, { error: 'not found' });
  }

  const stream = streams.get(parts[1]);

  if (parts[0] === 'cast') {
    if (!stream?.info) return send(res, 404, 'unknown stream (the relay may have restarted)');
    return send(res, 200, fs.readFileSync(CAST_HTML_PATH, 'utf8'), { 'content-type': 'text/html; charset=utf-8' });
  }

  if (parts[0] === 's' && parts[2] === 'live.m3u8' && parts.length === 3) {
    if (!stream?.info) return send(res, 404, 'unknown stream (the relay may have restarted)');
    if (stream.superseded) return send(res, 410, SUPERSEDED);
    if (!stream.channel) return send(res, 404, 'this cast has one stream; its playlist is at the media URL the cast page shows');
    if (viaNow) return serveChannel(parts[1], stream, res, (ch) => channelPlaylist(parts[1], ch, nowView(parts[1], ch)));
    return serveChannel(parts[1], stream, res);
  }

  const srcMatch = parts[0] === 's' && parts[2]?.match(/^r(\d*)$/);
  if (srcMatch && parts[3]) {
    if (!stream?.info) return send(res, 404, 'unknown stream (the relay may have restarted)');
    if (stream.superseded) return send(res, 410, SUPERSEDED);
    const src = Number(srcMatch[1] || 0);
    if (src >= stream.sources.length) return send(res, 404, `this cast has no stream ${src + 1}`);
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
    const started = Date.now();
    const r = await cachedFetch(parts[1], stream, upstream, src);
    // Per-request timing: shows whether the TV is starved (slow fetches) or fed junk.
    recordRequest(stream, {
      file: new URL(upstream).pathname.split('/').pop(),
      src,
      status: r.error ? r.status : 200,
      bytes: r.body?.length ?? 0,
      ms: Date.now() - started,
      type: r.type,
      head: r.body && !r.isPlaylist ? r.body.subarray(0, 8).toString('hex') : undefined,
    });
    if (r.error) return send(res, r.status, r.error, { 'content-type': 'text/plain' });
    let body = r.body;
    const run = !r.isPlaylist && stream.channel?.runOf.get(upstream);
    if (run) {
      try {
        body = await onTvClock(parts[1], stream, run, r.body);
      } catch (err) {
        recordError(parts[1], stream, err.message);
        return send(res, 502, err.message, { 'content-type': 'text/plain' });
      }
    }
    if (!r.isPlaylist) {
      // Whether the TV actually took the whole segment, and how long that took over the network.
      const name = new URL(upstream).pathname.split('/').pop().slice(0, 16);
      const sentAt = Date.now();
      res.on('close', () => {
        const ms = Date.now() - sentAt;
        if (res.writableFinished) console.log(`[relay] ${parts[1]}: sent ${name} (${r.body.length} B) to the TV in ${ms} ms`);
        else console.error(`[relay] ${parts[1]}: the TV hung up on ${name} after ${ms} ms, before it got all ${r.body.length} B`);
      });
    }
    return send(res, 200, body, { 'content-type': r.type });
  }

  send(res, 404, 'not found');
}

// The Chromecast asks for most segments twice, a few seconds apart. Without this, each ask
// is another full download through the player tab, which doubles the load and starves the TV
// on high-bitrate streams. Segments are kept briefly; playlists and failures never are.
const SEGMENT_KEEP_MS = 30000;
const segmentCache = new Map(); // upstream URL -> { promise, at }
function cachedFetch(id, stream, upstream, src) {
  const now = Date.now();
  for (const [url, e] of segmentCache) if (now - e.at > SEGMENT_KEEP_MS) segmentCache.delete(url);
  const hit = segmentCache.get(upstream);
  if (hit) return hit.promise;
  const promise = fetchUpstream(id, stream, upstream, src).then((r) => {
    if (r.error || r.isPlaylist) segmentCache.delete(upstream);
    return r;
  }, (err) => {
    segmentCache.delete(upstream);
    throw err;
  });
  segmentCache.set(upstream, { promise, at: now });
  return promise;
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
  console.log(`[relay] for a TV app (VLC, Fire TV), open ${LAN_BASE}${NOW_PATH}: it always plays the current cast`);
  if (process.env.RELAY_CHANNEL_WINDOW) console.log(`[relay] Swap on TV lists ${CHANNEL_WINDOW} segments to the TV (from RELAY_CHANNEL_WINDOW; default 12)`);
  if (process.env.RELAY_HOLD_SECONDS) console.log(`[relay] keeps ${HOLD_SECONDS} s of each live stream in reserve (from RELAY_HOLD_SECONDS; default 12)`);
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
