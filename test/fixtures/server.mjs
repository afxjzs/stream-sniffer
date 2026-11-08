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
export const WEBP_MASTER_URL = `${CDN}/live/webp/master.m3u8?token=${TOKEN}`;
export const GIF_MASTER_URL = `${CDN}/live/gif/master.m3u8?token=${TOKEN}`;
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

// The second disguise seen on a live site (Nov 2026): a 1x1 lossless WebP whose EXIF chunk is
// the whole TS segment, untouched. Laid out byte for byte like the real ones.
function disguiseAsWebp(ts) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]); // RIFF pads to even
  };
  const vp8l = Buffer.from('2f000000100710111188 88fe07'.replace(/ /g, ''), 'hex'); // the real 1x1 image
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8L', vp8l), chunk('EXIF', ts)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Stands in for the next disguise nobody has decoded yet: a GIF with the TS appended.
const disguiseAsGif = (ts) => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(26), ts]);

const DISGUISES = {
  png: ['image/png', disguiseAsPng],
  webp: ['image/webp', disguiseAsWebp],
  gif: ['image/gif', disguiseAsGif],
};

export const LIVE_A_URL = `${CDN}/live/a/master.m3u8?token=${TOKEN}`;
export const LIVE_B_URL = `${CDN}/live/b/master.m3u8?token=${TOKEN}`;

export function startServers({ streamDir, streamDirB, hlsJsPath, shakaJsPath }) {
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/page-made')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Page-Made Game</title>
<h1>Big Game</h1>
<iframe src="${EMBED}/embed?shaka=1" width="640" height="360" allow="autoplay"></iframe>`);
    }
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
    const embedPath = req.url.startsWith('/tricky')
      ? '/embed?tricky=1'
      : req.url.startsWith('/two-live')
        ? '/embed?two=1'
        : req.url.startsWith('/no-ext')
          ? '/embed?noext=1'
          : req.url.startsWith('/hidden')
            ? '/embed?hidden=1'
            : '/embed';
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
    if (req.url === '/shaka.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return fs.createReadStream(shakaJsPath).pipe(res);
    }
    if (req.url.includes('shaka=1')) {
      // Like a real embed (StreamEast "Server 1", Nov 2026): Shaka Player, with playlists that
      // never cross the network as .m3u8. The page registers its own vttp:// scheme; the list of
      // qualities is built in the page, and the live playlist comes from an address without
      // .m3u8 in it. Its segments are plain https links to the CDN.
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>embed</title>
<video id="v" autoplay muted playsinline width="640"></video>
<script src="/shaka.js"></script>
<script>
  shaka.polyfill.installAll();
  const MASTER = '#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,CODECS="avc1.64000d,mp4a.40.2"\\nvideo1_game.m3u8\\n';
  shaka.net.NetworkingEngine.registerScheme('vttp', (uri) => {
    const text = uri.endsWith('/master.m3u8')
      ? Promise.resolve(MASTER)
      : fetch(${JSON.stringify(`${CDN}/live/pg/pl?token=${TOKEN}`)}).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        });
    return shaka.util.AbortableOperation.notAbortable(
      text.then((t) => ({ uri, originalUri: uri, data: new TextEncoder().encode(t).buffer, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, status: 200 }))
    );
  });
  const player = new shaka.Player();
  player.attach(document.getElementById('v')).then(() => player.load('vttp://games.example/live/master.m3u8'))
    .catch((err) => { document.title = 'shaka failed: ' + (err.code || err.message); console.error(err); });
</script>`);
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
    if (req.url.includes('two=1')) {
      // Two live games on one page, like a site that shows a game and a whip-around channel.
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>embed</title>
<video id="a" autoplay muted playsinline width="320"></video>
<video id="b" autoplay muted playsinline width="320"></video>
<script src="/hls.min.js"></script>
<script>
  for (const [id, url] of [['a', ${JSON.stringify(LIVE_A_URL)}], ['b', ${JSON.stringify(LIVE_B_URL)}]]) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(document.getElementById(id));
  }
</script>`);
    }
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
    hls.loadSource(${JSON.stringify(
      tricky
        ? PNG_MASTER_URL
        : req.url.includes('noext=1')
          ? `${CDN}/live/ct/pl?token=${TOKEN}`
          : req.url.includes('hidden=1')
            ? `${CDN}/live/hid/pl?token=${TOKEN}`
            : MASTER_URL
    )});
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
  // /live/stall/: while Date.now() < until, the edge stays put; the next `hang` playlist
  // requests get no answer at all (held open until the server closes).
  const stall = { until: 0, edge: 0, hang: 0 };
  let downDrops = 0;
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
    // /live/a/ and /live/b/: plain live streams with different pictures (b is streamDirB).
    // /live/stall/: like a, with a 6-segment window, and its server can stop adding segments for
    // a while (stallLive below), as a real stream's source sometimes does; then it catches up.
    // /live/pg/pl: like a, but at an address without .m3u8 in it, and with absolute segment
    // links: the playlist the page-made embed (shaka=1) fetches.
    // /live/ct/pl: the same, with relative segment links, played by an ordinary hls.js page: a
    // playlist the browser fetches normally, whose address just doesn't say .m3u8.
    // /live/hid/pl: like ct, but labeled text/plain: a playlist nothing on the network gives away,
    // like a site whose delivery library hides it (tvsportslive.fr, Nov 2026).
    const live = url.pathname.match(/^\/live\/(rot|flaky|a|b|stall)\/index\.m3u8$/) ?? url.pathname.match(/^\/live\/(pg|ct|hid)\/pl$/);
    if (live) {
      if (live[1] === 'flaky' && ++flakyRefreshes === 3) {
        res.writeHead(503, { ...headers, 'content-type': 'text/plain' });
        return res.end('Backend fetch failed');
      }
      if (live[1] === 'stall' && stall.hang > 0) {
        stall.hang--;
        return; // as a CDN request that never comes back
      }
      liveStart[live[1]] ??= Date.now();
      let edge = Math.floor((Date.now() - liveStart[live[1]]) / 2000) + (live[1] === 'stall' ? 5 : 2);
      if (live[1] === 'stall') {
        if (Date.now() < stall.until) edge = stall.edge;
        else stall.edge = edge;
      }
      const first = Math.max(0, edge - (live[1] === 'stall' ? 5 : 2));
      const prefix = live[1] === 'rot' ? `p${++rotation}` : 'p0';
      // The 20 s of video loops, and its timestamps restart with it, so each loop is marked as a
      // discontinuity, as a real playlist would. Only a, b, and stall run long enough to loop.
      const loops = ['a', 'b', 'stall', 'pg', 'ct', 'hid'].includes(live[1]);
      const base = live[1] === 'pg' ? `${CDN}/live/pg/` : '';
      const looped = (sn) => loops && sn > 0 && sn % 10 === 0;
      let body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
      if (loops) body += `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / 10)}\n`;
      for (let sn = first; sn <= edge; sn++) {
        // The first segment's own loop is already counted in DISCONTINUITY-SEQUENCE.
        if (looped(sn) && sn !== first) body += '#EXT-X-DISCONTINUITY\n';
        body += `#EXTINF:2.000,\n${base}${prefix}/seg${sn % 10}.ts?token=${TOKEN}\n`;
      }
      // /live/hid/pl is labeled plain text, so nothing about its request says "playlist".
      res.writeHead(200, { ...headers, 'content-type': live[1] === 'hid' ? 'text/plain' : 'application/vnd.apple.mpegurl' });
      return res.end(body);
    }
    const rotSeg = url.pathname.match(/^\/live\/(rot|flaky|a|b|stall|pg|ct|hid)\/p\d+\/(seg\d+\.ts)$/);
    if (rotSeg) {
      res.writeHead(200, { ...headers, 'content-type': 'video/mp2t' });
      return res.end(fs.readFileSync(path.join(rotSeg[1] === 'b' ? streamDirB : streamDir, rotSeg[2])));
    }
    // /live/broken/: the variant playlist comes back as an HTML error page, as a flaky live CDN
    // sometimes does.
    if (url.pathname === '/live/broken/index.m3u8') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html' });
      return res.end('<html><body><h1>503 Service Unavailable</h1></body></html>');
    }
    if (/^\/live\/((png|webp|gif|broken|rot|flaky|a|b|stall)\/)?master\.m3u8$/.test(url.pathname)) {
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240\nindex.m3u8?token=${TOKEN}\n`
      );
    }
    // /live/down/: the first two requests for the master playlist get no answer (the connection
    // is dropped), as when a re-stream blips; hls.js retries once, then gives up.
    if (url.pathname === '/live/down/master.m3u8' && ++downDrops <= 2) return res.socket.destroy();
    if (url.pathname === '/live/down/master.m3u8') {
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240
index.m3u8?token=${TOKEN}
`);
    }
    // /live/multi/: two quality levels, the test video at 320x240 and at 1280x720 (under hi/).
    if (url.pathname === '/live/multi/master.m3u8') {
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240\nindex.m3u8?token=${TOKEN}&v=low\n` +
          `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhi/index.m3u8?token=${TOKEN}\n`
      );
    }
    const disguise = DISGUISES[url.pathname.match(/^\/live\/(\w+)\//)?.[1]];
    const sub = url.pathname.match(/^\/live\/(?:multi\/(hi)|(jitter))\//);
    const dir = sub ? path.join(streamDir, sub[1] ?? sub[2]) : streamDir;
    // PNG-disguised segments are named like the images they pretend to be (seg1.image), as a
    // real site's were (Nov 2026); the file behind them is still seg1.ts.
    const file = path.join(dir, path.basename(url.pathname).replace(/\.image$/, '.ts'));
    if (!url.pathname.startsWith('/live/') || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.m3u8')) {
      // Segment URLs need the token too, like real signed CDNs.
      body = body.toString().replace(/^(seg\d+\.ts)$/gm, `$1?token=${TOKEN}`);
      if (disguise?.[0] === 'image/png') body = body.replace(/^(seg\d+)\.ts\?/gm, '$1.image?');
    }
    if (disguise && !file.endsWith('.m3u8')) {
      const [type, wrap] = disguise;
      res.writeHead(200, { ...headers, 'content-type': type });
      return res.end(wrap(body));
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
    // Stops /live/stall/ from adding segments for ms milliseconds.
    // Makes the next /live/stall/ playlist request hang with no answer.
    hangNextPlaylist: () => {
      stall.hang++;
    },
    stallLive: (ms) => {
      stall.until = Date.now() + ms;
    },
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
