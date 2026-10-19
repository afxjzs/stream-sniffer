// A fake "stream site" shaped like the real ones:
//   site  (localhost:8001)  - the page you visit; embeds the player in a cross-origin iframe
//   embed (127.0.0.1:8002)  - the iframe; plays HLS with hls.js
//   cdn   (localhost:8003)  - serves the stream, but ONLY with an embed Referer and a token,
//                             and only sends CORS headers for the embed origin
//   cdn2  (127.0.0.1:8004)  - the same stream for /second, which plays it in the top page, so
//                             this CDN wants the SITE's Referer instead. Two streams that need
//                             different headers, for the multi-stream player.
//
// /tricky on the site mimics two real-world tricks: the embed fetches the stream through a
// service worker (Chrome reports those requests with no tab), and the stream's segments are
// disguised as PNG images (see disguiseAsPng). The tricky embed's own player can't decode those;
// only the capture and the extension's handling of the stream matter there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SITE = 'http://localhost:8001';
export const EMBED = 'http://127.0.0.1:8002';
export const CDN = 'http://localhost:8003';
export const TOKEN = 'abc123';
export const MASTER_URL = `${CDN}/live/master.m3u8?token=${TOKEN}`;
export const PNG_MASTER_URL = `${CDN}/live/png/master.m3u8?token=${TOKEN}`;
export const CDN2 = 'http://127.0.0.1:8004';
export const CDN2_MASTER_URL = `${CDN2}/live/master.m3u8?token=${TOKEN}`;

// Wraps a TS segment the way a live site does (see extension/disguise.js): an RGB PNG whose
// pixel bytes are "TIKTIKPX" + uint32 length + gzip(TS). Rows cycle through all five PNG
// filters so the decoder's unfiltering is exercised, as with the real images.
function disguiseAsPng(ts) {
  const gz = zlib.gzipSync(ts);
  const width = 512;
  const stride = width * 3;
  const payload = Buffer.concat([Buffer.from('TIKTIKPX'), Buffer.alloc(4), gz]);
  payload.writeUInt32BE(gz.length, 8);
  const height = Math.ceil(payload.length / stride);
  const px = Buffer.alloc(height * stride);
  payload.copy(px);
  const raw = Buffer.alloc(height * (stride + 1));
  for (let r = 0; r < height; r++) {
    const filter = r % 5;
    raw[r * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = px[r * stride + x];
      const a = x >= 3 ? px[r * stride + x - 3] : 0;
      const up = r > 0 ? px[(r - 1) * stride + x] : 0;
      const c = r > 0 && x >= 3 ? px[(r - 1) * stride + x - 3] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      raw[r * (stride + 1) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const idat = zlib.deflateSync(raw);
  const idats = [];
  for (let o = 0; o < idat.length; o += 8192) idats.push(chunk('IDAT', idat.subarray(o, o + 8192)));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...idats,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function startServers({ streamDir, hlsJsPath }) {
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/second')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Second Game</title>
<video id="v" autoplay muted playsinline width="640"></video>
<script src="${EMBED}/hls.min.js"></script>
<script>
  const hls = new Hls();
  hls.loadSource(${JSON.stringify(CDN2_MASTER_URL)});
  hls.attachMedia(document.getElementById('v'));
</script>`);
    }
    const embedPath = req.url.startsWith('/tricky') ? '/embed?tricky=1' : '/embed';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Fake Sports Site</title>
<h1>Big Game</h1>
<iframe src="${EMBED}${embedPath}" width="640" height="360" allow="autoplay"></iframe>`);
  });

  const embed = http.createServer((req, res) => {
    if (req.url === '/hls.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return fs.createReadStream(hlsJsPath).pipe(res);
    }
    if (req.url === '/sw.js') {
      // Passes every stream request through, so the network request comes from the worker.
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.url.startsWith(${JSON.stringify(CDN)})) e.respondWith(fetch(e.request));
});`);
    }
    const tricky = req.url.includes('tricky=1');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>embed</title>
<video id="v" autoplay muted playsinline width="640"></video>
<script src="/hls.min.js"></script>
<script>
  async function start() {
    ${tricky ? `await navigator.serviceWorker.register('/sw.js');
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }` : ''}
    const hls = new Hls();
    hls.loadSource(${JSON.stringify(tricky ? PNG_MASTER_URL : MASTER_URL)});
    hls.attachMedia(document.getElementById('v'));
  }
  start();
</script>`);
  });

  const rejected = [];
  const served = [];
  const liveStart = {}; // per live stream: when it was first requested
  let rotation = 0;
  let flakyRefreshes = 0;
  // allowed: the Referer prefix and CORS origin this CDN accepts.
  const makeCdn = (base, allowed) => http.createServer((req, res) => {
    const url = new URL(req.url, base);
    const referer = req.headers.referer || '';
    if (!referer.startsWith(allowed + '/') || url.searchParams.get('token') !== TOKEN) {
      rejected.push({ url: base + req.url, referer });
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    served.push(req.url);
    const headers = {};
    if (req.headers.origin === allowed) headers['access-control-allow-origin'] = allowed;

    // Live streams (2 s segments, 3 in the window, starting when first requested).
    // /live/rot/: segment paths get a new prefix on every refresh, as some CDNs do with rotating
    // tokens. The segment itself doesn't change.
    // /live/flaky/: the third playlist refresh fails with a 503, as a CDN whose backend blips.
    const live = url.pathname.match(/^\/live\/(rot|flaky)\/index\.m3u8$/);
    if (live) {
      if (live[1] === 'flaky' && ++flakyRefreshes === 3) {
        res.writeHead(503, { ...headers, 'content-type': 'text/plain' });
        return res.end('Backend fetch failed');
      }
      liveStart[live[1]] ??= Date.now();
      const edge = Math.floor((Date.now() - liveStart[live[1]]) / 2000) + 2;
      const first = Math.max(0, edge - 2);
      const prefix = live[1] === 'rot' ? `p${++rotation}` : 'p0';
      let body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
      for (let sn = first; sn <= edge; sn++) body += `#EXTINF:2.000,\n${prefix}/seg${sn % 10}.ts?token=${TOKEN}\n`;
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(body);
    }
    const rotSeg = url.pathname.match(/^\/live\/(?:rot|flaky)\/p\d+\/(seg\d+\.ts)$/);
    if (rotSeg) {
      res.writeHead(200, { ...headers, 'content-type': 'video/mp2t' });
      return res.end(fs.readFileSync(path.join(streamDir, rotSeg[1])));
    }
    // /live/broken/: the variant playlist comes back as an HTML error page, as a flaky live CDN
    // sometimes does.
    if (url.pathname === '/live/broken/index.m3u8') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html' });
      return res.end('<html><body><h1>503 Service Unavailable</h1></body></html>');
    }
    if (['/live/master.m3u8', '/live/png/master.m3u8', '/live/broken/master.m3u8', '/live/rot/master.m3u8', '/live/flaky/master.m3u8'].includes(url.pathname)) {
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240\nindex.m3u8?token=${TOKEN}\n`
      );
    }
    const png = url.pathname.startsWith('/live/png/');
    const file = path.join(streamDir, path.basename(url.pathname));
    if (!url.pathname.startsWith('/live/') || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.m3u8')) {
      // Segment URLs need the token too, like real signed CDNs.
      body = body.toString().replace(/^(seg\d+\.ts)$/gm, `$1?token=${TOKEN}`);
    }
    if (png && !file.endsWith('.m3u8')) {
      res.writeHead(200, { ...headers, 'content-type': 'image/png' });
      return res.end(disguiseAsPng(body));
    }
    res.writeHead(200, {
      ...headers,
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    });
    res.end(body);
  });
  const cdn = makeCdn(CDN, EMBED);
  const cdn2 = makeCdn(CDN2, SITE);

  const servers = [
    [site, 8001],
    [embed, 8002],
    [cdn, 8003],
    [cdn2, 8004],
  ];
  return Promise.all(
    servers.map(
      ([s, port]) =>
        new Promise((resolve, reject) => {
          s.once('error', reject);
          s.listen(port, resolve);
        })
    )
  ).then(() => ({
    rejected,
    served,
    // closeAllConnections: keep-alive sockets (from fetch and the relay) would otherwise hold
    // close() open forever.
    close: () =>
      Promise.all(
        servers.map(([s]) => new Promise((r) => {
          s.close(r);
          s.closeAllConnections();
        }))
      ),
  }));
}
