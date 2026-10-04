// A fake "stream site" shaped like the real ones:
//   site  (localhost:8001)  - the page you visit; embeds the player in a cross-origin iframe
//   embed (127.0.0.1:8002)  - the iframe; plays HLS with hls.js
//   cdn   (localhost:8003)  - serves the stream, but ONLY with an embed Referer and a token,
//                             and only sends CORS headers for the embed origin
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const SITE = 'http://localhost:8001';
export const EMBED = 'http://127.0.0.1:8002';
export const CDN = 'http://localhost:8003';
export const TOKEN = 'abc123';
export const MASTER_URL = `${CDN}/live/master.m3u8?token=${TOKEN}`;

export function startServers({ streamDir, hlsJsPath }) {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Fake Sports Site</title>
<h1>Big Game</h1>
<iframe src="${EMBED}/embed" width="640" height="360" allow="autoplay"></iframe>`);
  });

  const embed = http.createServer((req, res) => {
    if (req.url === '/hls.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return fs.createReadStream(hlsJsPath).pipe(res);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>embed</title>
<video id="v" autoplay muted playsinline width="640"></video>
<script src="/hls.min.js"></script>
<script>
  const hls = new Hls();
  hls.loadSource(${JSON.stringify(MASTER_URL)});
  hls.attachMedia(document.getElementById('v'));
</script>`);
  });

  const rejected = [];
  const served = [];
  const cdn = http.createServer((req, res) => {
    const url = new URL(req.url, CDN);
    const referer = req.headers.referer || '';
    if (!referer.startsWith(EMBED + '/') || url.searchParams.get('token') !== TOKEN) {
      rejected.push({ url: req.url, referer });
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    served.push(req.url);
    const headers = {};
    if (req.headers.origin === EMBED) headers['access-control-allow-origin'] = EMBED;

    if (url.pathname === '/live/master.m3u8') {
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240\nindex.m3u8?token=${TOKEN}\n`
      );
    }
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
    res.writeHead(200, {
      ...headers,
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    });
    res.end(body);
  });

  const servers = [
    [site, 8001],
    [embed, 8002],
    [cdn, 8003],
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
