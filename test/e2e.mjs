// End-to-end test: load the unpacked extension in Chrome for Testing, visit a fake stream
// site, and check what a user can see and do: the popup lists the captured stream, the
// VLC command carries headers the CDN accepts, and the built-in player actually plays it.
//
// Run: cd test && npm install && npm test
// Artifacts (screenshots) land in test/artifacts/.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServers, SITE, EMBED, MASTER_URL, CDN2_MASTER_URL, WEBP_MASTER_URL, GIF_MASTER_URL } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const streamDir = path.join(here, 'fixtures/stream');
const streamDirB = path.join(here, 'fixtures/stream-b');
const artifactsDir = path.join(here, 'artifacts');
const relayPath = path.resolve(here, '../relay/server.mjs');
// Not 8788, so the test can run while your own relay is up.
const RELAY_PORT = 8789;
const RELAY = `http://localhost:${RELAY_PORT}`;
const HEADLESS = process.env.HEADFUL ? false : true;

function step(msg) {
  console.log(`\n▶ ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  ok(msg);
}

// Two streams with different pictures, so a test can tell which one reached the TV.
function ensureStreams() {
  ensureStream(streamDir, 'testsrc', 440);
  ensureStream(streamDirB, 'testsrc2', 880);
}

function ensureStream(dir, pattern, tone) {
  if (fs.existsSync(path.join(dir, 'index.m3u8'))) return;
  step(`Generating test HLS stream in ${path.basename(dir)} with ffmpeg`);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `${pattern}=size=320x240:rate=25`,
      '-f', 'lavfi', '-i', `sine=frequency=${tone}`,
      '-t', '20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50',
      '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
      path.join(dir, 'index.m3u8'),
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed with exit code ${r.status} (${r.error ?? ''})`);
}

// waitForFunction, unlike evaluate, survives navigations: a tab opened by chrome.tabs.create
// can be found while it is still on its initial blank document.
async function waitForPlayback(frameOrPage, label, minSeconds = 1.5, timeoutMs = 20000) {
  try {
    const handle = await frameOrPage.waitForFunction(
      (min) => {
        const t = document.querySelector('video')?.currentTime ?? -1;
        return t >= min ? t : false;
      },
      { timeout: timeoutMs, polling: 250 },
      minSeconds
    );
    return handle.jsonValue();
  } catch (err) {
    const t = await frameOrPage
      .evaluate(() => document.querySelector('video')?.currentTime ?? -1)
      .catch((e) => `unreadable: ${e.message}`);
    throw new Error(`${label}: video never reached ${minSeconds}s of playback (currentTime=${t}): ${err.message}`);
  }
}

// Waits until some visible leaf element's text matches the regex; returns that text. Text in a
// closed menu or a collapsed section doesn't count: the user can't see it.
async function waitForText(page, re, timeoutMs = 10000) {
  const handle = await page.waitForFunction(
    (src, flags) => {
      const rx = new RegExp(src, flags);
      const el = [...document.querySelectorAll('body *')].find(
        (e) => e.children.length === 0 && rx.test(e.textContent) && e.checkVisibility()
      );
      return el ? el.textContent : false;
    },
    { timeout: timeoutMs, polling: 100 },
    re.source,
    re.flags
  );
  return handle.jsonValue();
}

// Starts the relay the way a user would (`node relay/server.mjs`) and waits for its "ready"
// line, which it prints only after checking that localhost and the LAN address reach it.
function startRelay() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [relayPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A short Swap on TV window, so a swap's discontinuity scrolls off within the test.
      env: { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_CHANNEL_WINDOW: '4' },
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('relay did not print "ready" within 10s'));
    }, 10000);
    proc.stdout.on('data', (d) => {
      process.stdout.write(`    [relay] ${d}`);
      if (String(d).includes('[relay] ready')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (d) => process.stdout.write(`    [relay:err] ${d}`));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with code ${code}`)); // no-op if already resolved
    });
  });
}

const firstUri = (playlist) => playlist.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim();

async function main() {
  ensureStreams();
  fs.mkdirSync(artifactsDir, { recursive: true });

  const servers = await startServers({
    streamDir,
    streamDirB,
    hlsJsPath: path.join(extDir, 'vendor/hls.min.js'),
  });
  let browser;
  let relay;
  try {
    step('Fixture sanity: the CDN really does reject requests without the embed Referer');
    const noRef = await fetch(MASTER_URL);
    assert(noRef.status === 403, `no Referer -> 403 (got ${noRef.status})`);
    const withRef = await fetch(MASTER_URL, { headers: { referer: EMBED + '/' } });
    assert(withRef.status === 200, `embed Referer -> 200 (got ${withRef.status})`);

    // A relay you started by hand would answer instead of the one this test starts.
    const strayRelay = await fetch(`${RELAY}/health`).then((r) => r.text(), () => null);
    if (strayRelay !== null) {
      throw new Error(`something is already running on ${RELAY} (${strayRelay.slice(0, 60)}). Is a previous test run still alive?`);
    }

    step('Launch Chrome for Testing with the extension');
    browser = await puppeteer.launch({ headless: HEADLESS, pipe: true, enableExtensions: [extDir] });
    // browser.extensions() is empty until the extension finishes registering; its service
    // worker starting is the signal that it has.
    await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'),
      { timeout: 10000 }
    );
    const extensions = await browser.extensions();
    const ext = [...extensions.values()].find((e) => e.path === extDir);
    assert(ext, `extension loaded (id ${ext?.id})`);
    const [sw] = await ext.workers();
    await sw.evaluate((url) => chrome.storage.local.set({ relayUrl: url }), RELAY);

    step('Visit the fake site and let its embedded player start');
    const page = await browser.newPage();
    await page.goto(SITE + '/');
    const embedFrame = await page.waitForFrame((f) => f.url().startsWith(EMBED));
    const embedTime = await waitForPlayback(embedFrame, 'site embed player');
    ok(`site's own player is playing (t=${embedTime.toFixed(1)}s)`);

    step('Open the extension popup on that tab');
    await page.bringToFront();
    await ext.triggerAction(page);
    const popupTarget = await browser.waitForTarget((t) => t.url().includes('/popup.html'), {
      timeout: 5000,
    });
    const popup = await popupTarget.asPage();
    await popup.waitForSelector('::-p-text(master.m3u8)', { timeout: 5000 });
    ok('popup lists master.m3u8');
    await popup.screenshot({ path: path.join(artifactsDir, 'popup.png') });

    let masterItem = null;
    for (const li of await popup.$$('li')) {
      if ((await li.evaluate((el) => el.textContent)).includes('live/master.m3u8')) masterItem = li;
    }
    assert(masterItem, 'popup has a list entry for master.m3u8');
    const popupText = await popup.$eval('body', (b) => b.innerText);
    assert(
      !popupText.includes('http-referrer') && !popupText.includes(MASTER_URL),
      'the popup leads with the player buttons; commands and full URLs stay tucked away'
    );

    step('The VLC command the popup copies carries headers the CDN accepts');
    // The clipboard is the outside world here: record what the popup copies instead.
    await popup.evaluate(() => {
      window.copied = [];
      navigator.clipboard.writeText = async (text) => void window.copied.push(text);
    });
    const copyFromMaster = async (label) => {
      await (await masterItem.$(`button::-p-text(${label})`)).click();
      return popup.evaluate(() => window.copied.at(-1));
    };
    await (await masterItem.$('::-p-aria(More)')).click();
    const vlcCmd = await copyFromMaster('Copy VLC command');
    console.log(`  command: ${vlcCmd}`);
    const referrer = vlcCmd.match(/--http-referrer='([^']+)'/)?.[1];
    const cmdUrl = vlcCmd.match(/'(https?:\/\/[^']*master\.m3u8[^']*)'/)?.[1];
    assert(cmdUrl === MASTER_URL, `command has the master playlist URL (${cmdUrl})`);
    const viaCmd = await fetch(cmdUrl, { headers: { referer: referrer } });
    assert(viaCmd.status === 200, `fetching with the command's referrer -> 200 (got ${viaCmd.status})`);

    step('The curl command the popup copies replays the browser request exactly');
    const curlCmd = await copyFromMaster('Copy curl command');
    assert(curlCmd?.startsWith('curl ') && curlCmd.includes('master.m3u8'), 'popup copies a curl command for the master playlist');
    // Async on purpose: the fake CDN lives in this process, so a blocking spawnSync would deadlock.
    const curlRun = await new Promise((resolve) =>
      execFile('sh', ['-c', `${curlCmd} -o /dev/null -w '%{http_code}'`], { timeout: 10000 }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code ?? err.signal : 0, stdout, stderr })
      )
    );
    assert(
      curlRun.code === 0 && curlRun.stdout === '200',
      `running the curl command -> HTTP 200 (exit ${curlRun.code}, got "${curlRun.stdout}" ${curlRun.stderr})`
    );

    step('"Open in player" plays the stream in the extension player');
    const playerTargetP = browser.waitForTarget((t) => t.url().includes('/player.html'), {
      timeout: 5000,
    });
    const openBtn = await masterItem.$('button::-p-text(Open in player)');
    assert(openBtn, 'master entry has an "Open in player" button');
    await openBtn.click();
    const player = await (await playerTargetP).asPage();
    await player.bringToFront();
    const playerTime = await waitForPlayback(player, 'extension player');
    ok(`extension player is playing (t=${playerTime.toFixed(1)}s)`);
    await player.click('::-p-aria(Settings)');
    const sourceText = await waitForText(player, /Fake Sports Site/, 5000);
    assert(
      (await player.$eval('a[href]', (a) => a.href).catch(() => '')) === SITE + '/',
      `player shows where the stream came from ("${sourceText}", linked to ${SITE}/)`
    );
    assert((await player.title()).includes('Fake Sports Site'), `player tab title names the source page ("${await player.title()}")`);
    await player.click('::-p-aria(Settings)'); // close the menu
    await player.screenshot({ path: path.join(artifactsDir, 'player-from-popup.png') });

    step('The video fills the tab; the controls sit behind a settings button');
    const fills = await player.$eval('video', (v) => {
      const r = v.getBoundingClientRect();
      return r.width === innerWidth && r.height === innerHeight;
    });
    assert(fills, 'video covers the whole tab');
    await player.click('::-p-aria(Settings)');
    await player.waitForSelector('button::-p-text(Pop out)', { visible: true, timeout: 5000 });
    ok('the settings button opens the menu');

    step('"Pop out" puts the video in a floating picture-in-picture window, and can bring it back');
    await player.click('button::-p-text(Pop out)');
    await player.waitForFunction(() => document.pictureInPictureElement?.tagName === 'VIDEO', { timeout: 5000 });
    ok('video is in picture-in-picture');
    await player.click('button::-p-text(Back to tab)');
    await player.waitForFunction(() => !document.pictureInPictureElement, { timeout: 5000 });
    ok('video is back in the tab');
    await player.click('::-p-aria(Settings)'); // close the menu

    step('"Add to player" puts a stream that needs other headers in a small window; clicking it swaps picture and sound');
    servers.rejected.length = 0;
    const second = await browser.newPage();
    await second.goto(SITE + '/second');
    await waitForPlayback(second, "second site's own player");
    await second.bringToFront();
    const popup3P = browser.waitForTarget((t) => t.url().includes('/popup.html') && t !== popupTarget, { timeout: 5000 });
    await ext.triggerAction(second);
    const popup3Target = await popup3P;
    const popup3 = await popup3Target.asPage();
    await popup3.waitForSelector(`::-p-text(${new URL(CDN2_MASTER_URL).host})`, { timeout: 5000 });
    await popup3.click('button::-p-text(Add to player)');
    const sizes = () =>
      player.$$eval('video', (vs) =>
        vs.filter((v) => !v.hidden).map((v) => {
          const r = v.getBoundingClientRect();
          return { area: r.width * r.height, muted: v.muted, t: v.currentTime };
        })
      );
    await player.waitForFunction(
      () => [...document.querySelectorAll('video')].filter((v) => !v.hidden && v.currentTime >= 1.5).length === 2,
      { timeout: 20000, polling: 250 }
    );
    let [a, b] = await sizes();
    assert(b.area < a.area / 4, `second stream plays in a small window over the first (areas ${a.area} / ${b.area})`);
    assert(b.muted, 'the small window is muted');
    assert(servers.rejected.length === 0, `both CDNs accepted the headers sent (${JSON.stringify(servers.rejected)})`);
    const [bigEl, smallEl] = await player.$$('video');
    await smallEl.click();
    [a, b] = await sizes();
    assert(b.area > a.area * 4, 'after clicking it, the small one is now big');
    assert(!b.muted && a.muted, 'and the sound moved with it');
    await bigEl.click(); // bigEl is the small one now
    [a, b] = await sizes();
    assert(a.area > b.area * 4, 'clicking again swaps back');

    const smallRect = () =>
      player.$$eval('video', (vs) => {
        const r = vs.filter((v) => !v.hidden).map((v) => v.getBoundingClientRect()).sort((p, q) => p.width - q.width)[0];
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
    const drag = async (fromX, fromY, dx, dy) => {
      await player.mouse.move(fromX, fromY);
      await player.mouse.down();
      await player.mouse.move(fromX + dx, fromY + dy, { steps: 8 });
      await player.mouse.up();
    };
    const before = await smallRect();
    await drag(before.x + before.w / 2, before.y + before.h / 2, -200, -100);
    const moved = await smallRect();
    assert(
      Math.abs(moved.x - (before.x - 200)) < 2 && Math.abs(moved.y - (before.y - 100)) < 2 && moved.w === before.w,
      `dragging the small window moves it (${JSON.stringify(before)} -> ${JSON.stringify(moved)})`
    );
    [a, b] = await sizes();
    assert(a.area > b.area * 4, 'dragging it does not swap');
    await drag(moved.x + 3, moved.y + 3, -100, 0); // top-left corner, outward
    const resized = await smallRect();
    assert(
      Math.abs(resized.w - (moved.w + 100)) < 2 && Math.abs(resized.x + resized.w - (moved.x + moved.w)) < 2,
      `dragging a corner resizes it, keeping the opposite corner in place (${JSON.stringify(moved)} -> ${JSON.stringify(resized)})`
    );

    // After a reload both streams load at the same time, each needing its own headers.
    await player.reload();
    await player
      .waitForFunction(
        () => [...document.querySelectorAll('video')].filter((v) => !v.hidden && v.currentTime >= 1.5).length === 2,
        { timeout: 20000, polling: 250 }
      )
      .catch((err) => {
        throw new Error(`after a reload, both streams did not play (CDN rejected: ${JSON.stringify(servers.rejected)}): ${err.message}`);
      });
    [a, b] = await sizes();
    assert(a.area > b.area * 4, 'a reload brings back both pictures, same one big');
    const afterReload = await smallRect();
    assert(
      Math.abs(afterReload.x - resized.x) < 2 && Math.abs(afterReload.w - resized.w) < 2,
      `the small window keeps its place and size (${JSON.stringify(afterReload)})`
    );
    assert(servers.rejected.length === 0, `both CDNs still accepted every request (${JSON.stringify(servers.rejected)})`);
    await player.screenshot({ path: path.join(artifactsDir, 'player-two-streams.png') });
    await player.click('::-p-aria(Settings)');
    await player.screenshot({ path: path.join(artifactsDir, 'player-menu.png') });
    await player.click('::-p-aria(Settings)'); // close the menu

    await player.click('::-p-aria(Remove the small stream)');
    const visible = () => player.$$eval('video', (vs) => vs.filter((v) => !v.hidden).length);
    await player.waitForFunction(() => [...document.querySelectorAll('video')].filter((v) => !v.hidden).length === 1, {
      timeout: 5000,
      polling: 100,
    });
    const keptT = await player.evaluate(() => [...document.querySelectorAll('video')].find((v) => !v.hidden).currentTime);
    await player.waitForFunction(
      (t) => [...document.querySelectorAll('video')].find((v) => !v.hidden).currentTime >= t + 1,
      { timeout: 5000, polling: 250 },
      keptT
    );
    ok('the × on the small window removes it; the big one keeps playing');
    await player.reload();
    await waitForPlayback(player, 'player after removing the small stream and reloading');
    assert((await visible()) === 1, 'it stays removed after a reload');
    await player.click('::-p-aria(Settings)');

    step('"Cast via relay" without the relay running says how to start it');
    await player.click('button::-p-text(Cast via relay)');
    const noRelayMsg = await waitForText(player, /^Relay:.*relay\/server\.mjs/);
    ok(`player reports: "${noRelayMsg}"`);

    step('Start the relay; "Cast via relay" shows the cast controls inside the player, with a LAN address for the TV');
    relay = await startRelay();
    await player.click('button::-p-text(Cast via relay)');
    const castFrame = await player.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 10000 });
    const mediaText = await waitForText(castFrame, /http:\/\/[\d.]+:8789\/\S+/);
    const mediaUrl = mediaText.match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    ok(`cast controls show the URL the Chromecast will load: ${mediaUrl}`);
    assert(!/^http:\/\/127\./.test(mediaUrl), 'that URL is a LAN address, not loopback (the TV must reach it)');
    const castTabs = (await browser.pages()).filter((p) => p.url().startsWith(`${RELAY}/cast/`));
    assert(castTabs.length === 0, 'no separate cast tab was opened');
    await player.screenshot({ path: path.join(artifactsDir, 'player-with-cast.png') });

    step('Acting as the Chromecast: plain GETs (no Referer, no cookies) get real video via the relay');
    servers.rejected.length = 0;
    const master = await fetch(mediaUrl);
    assert(master.status === 200, `master playlist -> 200 (got ${master.status})`);
    assert(master.headers.get('access-control-allow-origin') === '*', 'relay sends CORS header for the receiver');
    const variantUrl = new URL(firstUri(await master.text()), mediaUrl).href;
    assert(variantUrl.startsWith(`${new URL(mediaUrl).origin}/`), `variant playlist URL points back at the relay (${variantUrl})`);
    const variant = await fetch(variantUrl);
    assert(variant.status === 200, `variant playlist -> 200 (got ${variant.status})`);
    const segUrl = new URL(firstUri(await variant.text()), variantUrl).href;
    assert(segUrl.startsWith(`${new URL(mediaUrl).origin}/`), 'segment URL points back at the relay');
    const seg = await fetch(segUrl);
    const segBytes = new Uint8Array(await seg.arrayBuffer());
    assert(seg.status === 200 && segBytes[0] === 0x47, `segment -> 200 with MPEG-TS data (${seg.status}, ${segBytes.length} bytes)`);
    assert(servers.rejected.length === 0, `CDN rejected nothing the relay sent (${JSON.stringify(servers.rejected)})`);

    step('The relay is not an open proxy on the LAN');
    const foreign = mediaUrl.replace(/\/r\/[^/]+\//, `/r/${Buffer.from('http://example.com/x.m3u8').toString('base64url')}/`);
    const foreignRes = await fetch(foreign);
    assert(foreignRes.status === 403, `URL for an unrelated host -> 403 (got ${foreignRes.status})`);

    step('Tricky site (service worker + PNG-disguised segments): captured, plays, and casts');
    const tricky = await browser.newPage();
    await tricky.goto(SITE + '/tricky');
    await tricky.waitForFrame((f) => f.url().startsWith(EMBED));
    await tricky.bringToFront();
    const popup2P = browser.waitForTarget(
      (t) => t.url().includes('/popup.html') && t !== popupTarget && t !== popup3Target,
      { timeout: 5000 }
    );
    await ext.triggerAction(tricky);
    const popup2 = await (await popup2P).asPage();
    await popup2.waitForSelector('::-p-text(png/master.m3u8)', { timeout: 5000 });
    ok('popup lists the playlist the service worker fetched');
    let trickyItem = null;
    for (const li of await popup2.$$('li')) {
      if ((await li.evaluate((el) => el.textContent)).includes('png/master.m3u8')) trickyItem = li;
    }
    const trickyPlayerP = browser.waitForTarget((t) => t.url().includes('/player.html') && t.url() !== player.url(), { timeout: 5000 });
    await (await trickyItem.$('button::-p-text(Open in player)')).click();
    const trickyPlayer = await (await trickyPlayerP).asPage();
    await trickyPlayer.bringToFront();
    await waitForPlayback(trickyPlayer, 'extension player on PNG-disguised stream');
    ok('extension player plays the PNG-disguised stream');
    await trickyPlayer.click('::-p-aria(Settings)');
    await trickyPlayer.click('button::-p-text(Cast via relay)');
    const trickyFrame = await trickyPlayer.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 10000 });
    const trickyMedia = (await waitForText(trickyFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    const tMaster = await (await fetch(trickyMedia)).text();
    const tVariantUrl = new URL(firstUri(tMaster), trickyMedia).href;
    const tSegUrl = new URL(firstUri(await (await fetch(tVariantUrl)).text()), tVariantUrl).href;
    const tSeg = await fetch(tSegUrl);
    const tBytes = new Uint8Array(await tSeg.arrayBuffer());
    assert(
      tSeg.status === 200 && tBytes[0] === 0x47 && tSeg.headers.get('content-type') === 'video/mp2t',
      `relay hands the TV plain MPEG-TS, not the PNG wrapper (${tSeg.status}, first byte 0x${tBytes[0]?.toString(16)}, ${tSeg.headers.get('content-type')})`
    );

    step('WebP-disguised segments (TS inside a 1x1 WebP\'s EXIF chunk): the player plays them and the relay casts plain MPEG-TS');
    // A real site did this in Nov 2026; the relay sent the WebP bytes to the TV as video/mp2t
    // and the TV buffered forever.
    const webp = await browser.newPage();
    await webp.goto(`chrome-extension://${ext.id}/player.html`);
    await webp.type('input[name=url]', WEBP_MASTER_URL);
    await webp.type('input[name=referer]', EMBED + '/');
    await webp.click('button::-p-text(Play)');
    await waitForPlayback(webp, 'extension player on WebP-disguised stream');
    ok('extension player plays the WebP-disguised stream');
    await webp.click('button::-p-text(Cast via relay)');
    const webpFrame = await webp.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 10000 });
    const webpMedia = (await waitForText(webpFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    const wVariantUrl = new URL(firstUri(await (await fetch(webpMedia)).text()), webpMedia).href;
    const wSegUrl = new URL(firstUri(await (await fetch(wVariantUrl)).text()), wVariantUrl).href;
    const wSeg = await fetch(wSegUrl);
    const wBytes = new Uint8Array(await wSeg.arrayBuffer());
    const original = fs.readFileSync(path.join(streamDir, 'seg0.ts'));
    assert(
      wSeg.status === 200 && wSeg.headers.get('content-type') === 'video/mp2t' && Buffer.from(wBytes).equals(original),
      `relay hands the TV the original MPEG-TS segment, not the WebP wrapper (${wSeg.status}, ${wBytes.length} bytes, starts ${Buffer.from(wBytes.subarray(0, 4)).toString('hex')}, ${wSeg.headers.get('content-type')})`
    );
    await webp.close();

    step('A segment in an image format nobody can decode stops the cast with a reason, instead of reaching the TV as junk');
    const gif = await browser.newPage();
    await gif.goto(`chrome-extension://${ext.id}/player.html`);
    await gif.type('input[name=url]', GIF_MASTER_URL);
    await gif.type('input[name=referer]', EMBED + '/');
    await gif.click('button::-p-text(Play)');
    await gif.click('button::-p-text(Cast via relay)');
    const gifMsg = await waitForText(gif, /^Relay:.*image/i, 15000);
    ok(`player reports: "${gifMsg}"`);
    const gifFrames = gif.frames().filter((f) => f.url().startsWith(`${RELAY}/cast/`));
    assert(gifFrames.length === 0, 'no cast controls are offered for it');
    await gif.close();

    step('Swap on TV: two live streams cast as one channel, and Swap switches what the TV gets');
    const hash = (b) => crypto.createHash('sha1').update(b).digest('hex');
    const segHashes = (dir) => new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => hash(fs.readFileSync(path.join(dir, f)))));
    const [aSegs, bSegs] = [segHashes(streamDir), segHashes(streamDirB)];
    const streamOf = (bytes) => (aSegs.has(hash(bytes)) ? 'A' : bSegs.has(hash(bytes)) ? 'B' : `neither (starts ${bytes.subarray(0, 4).toString('hex')})`);
    const tvGet = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`TV request ${url} -> HTTP ${r.status}: ${await r.text()}`);
      return r;
    };
    // What a TV reads from a live media playlist.
    const readPlaylist = async (url) => {
      const text = await (await tvGet(url)).text();
      const num = (tag) => Number(text.match(new RegExp(`#${tag}:(\\d+)`))?.[1] ?? 0);
      const entries = [];
      let disc = false;
      let discNo = num('EXT-X-DISCONTINUITY-SEQUENCE'); // which stretch of timeline a segment is in
      for (const line of text.split('\n').map((l) => l.trim())) {
        if (line === '#EXT-X-DISCONTINUITY') disc = true;
        else if (line && !line.startsWith('#')) {
          if (disc) discNo++;
          entries.push({ seq: num('EXT-X-MEDIA-SEQUENCE') + entries.length, uri: new URL(line, url).href, disc, discNo });
          disc = false;
        }
      }
      return { text, live: !text.includes('#EXT-X-ENDLIST'), seq: num('EXT-X-MEDIA-SEQUENCE'), discSeq: num('EXT-X-DISCONTINUITY-SEQUENCE'), entries };
    };
    const lastStream = async (pl) => streamOf(Buffer.from(await (await tvGet(pl.entries.at(-1).uri)).arrayBuffer()));
    // From one refresh to the next, a segment number must keep pointing at the same segment, in
    // the same stretch of timeline (its discontinuity number), or the TV misplaces it.
    // quiet: for checks repeated in a loop, print nothing when it holds (a failure still throws).
    const assertConsistent = (before, after, what, { quiet = false } = {}) => {
      const was = new Map(before.entries.map((e) => [e.seq, e]));
      const changed = after.entries.filter((e) => was.has(e.seq) && (was.get(e.seq).uri !== e.uri || was.get(e.seq).discNo !== e.discNo));
      const holds = after.seq >= before.seq && after.discSeq >= before.discSeq && changed.length === 0;
      const msg = `${what}: sequence numbers only move forward (${before.seq} -> ${after.seq}, discontinuity ${before.discSeq} -> ${after.discSeq}) and no segment changed meaning${changed.length ? ` (changed: ${JSON.stringify(changed)})` : ''}`;
      if (quiet && holds) return;
      assert(holds, msg);
    };
    const swapTo = async (frame, before, expect) => {
      // The ⚙ menu scrolls, and with two streams the cast controls can sit below its fold, as
      // a user would see: bring them into view first.
      await ch.$eval('#cast-frame', (f) => f.scrollIntoView({ block: 'start' }));
      const was = await frame.$eval('#on-tv', (el) => el.textContent);
      // A user could click it: it's enabled, and it's what sits under its own center, both in
      // the cast page and in the player page around that frame.
      const btn = await frame.$eval('#swap', (b) => {
        const r = b.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        return { x, y, disabled: b.disabled, onTop: document.elementFromPoint(x, y) === b, inView: y > 0 && y < innerHeight };
      });
      const pageHit = await ch.evaluate(({ x, y }) => {
        const f = document.getElementById('cast-frame');
        const r = f.getBoundingClientRect();
        return document.elementFromPoint(r.x + x, r.y + y) === f && r.y + y < innerHeight;
      }, btn);
      assert(!btn.disabled && btn.onTop && btn.inView && pageHit, 'Swap on TV is enabled, visible, and not covered');
      // Puppeteer's mouse doesn't reliably land in this cross-origin frame inside the scrolled
      // menu (2 of 3 runs missed with everything above true), so activate it directly.
      await frame.$eval('#swap', (b) => b.click());
      await frame
        .waitForFunction((w) => document.getElementById('on-tv').textContent !== w, { timeout: 5000 }, was)
        .catch(async () => {
          const shot = path.join(artifactsDir, 'swap-click-failed.png');
          await ch.screenshot({ path: shot });
          const note = await frame.$eval('#swap-note', (el) => el.textContent).catch((e) => `unreadable: ${e.message}`);
          const error = await frame.$eval('#error', (el) => (el.hidden ? '' : el.textContent)).catch((e) => `unreadable: ${e.message}`);
          const btn = await frame.$eval('#swap', (b) => {
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
          });
          const under = await ch.evaluate(({ x, y }) => {
            const f = document.getElementById('cast-frame').getBoundingClientRect();
            const el = document.elementFromPoint(f.x + x, f.y + y);
            return `${el?.tagName}#${el?.id} at (${Math.round(f.x + x)}, ${Math.round(f.y + y)})`;
          }, btn);
          throw new Error(
            `clicking Swap on TV did nothing (the cast controls still say "${was}"; note "${note}"; error "${error}"; button disabled=${btn.disabled}; the player page has ${under} under the button). Screenshot: ${shot}`
          );
        });
      // The new stream joins at the next playlist refresh the TV makes.
      const deadline = Date.now() + 15000;
      for (;;) {
        const pl = await readPlaylist(chMedia);
        const discs = pl.entries.filter((e) => e.disc).length + pl.discSeq;
        if (discs > before.entries.filter((e) => e.disc).length + before.discSeq && (await lastStream(pl)) === expect) return pl;
        if (Date.now() > deadline) throw new Error(`the TV's playlist never switched to stream ${expect}:\n${pl.text}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    };

    const twoLive = await browser.newPage();
    await twoLive.goto(SITE + '/two-live');
    await twoLive.waitForFrame((f) => f.url().startsWith(EMBED));
    await twoLive.bringToFront();
    const openPopup = async (tab) => {
      const known = new Set(browser.targets());
      const p = browser.waitForTarget((t) => !known.has(t) && t.url().includes('/popup.html'), { timeout: 5000 });
      await ext.triggerAction(tab);
      return (await p).asPage();
    };
    const itemFor = async (popup, text) => {
      await popup.waitForSelector(`::-p-text(${text})`, { timeout: 10000 });
      for (const li of await popup.$$('li')) if ((await li.evaluate((el) => el.textContent)).includes(text)) return li;
      throw new Error(`no popup entry for ${text}`);
    };
    const knownTargets = new Set(browser.targets());
    const chP = browser.waitForTarget((t) => !knownTargets.has(t) && t.url().includes('/player.html'), { timeout: 5000 });
    await (await (await itemFor(await openPopup(twoLive), 'a/master.m3u8')).$('button::-p-text(Open in player)')).click();
    const ch = await (await chP).asPage();
    await ch.bringToFront(); // "Add to player" goes to the player tab used last
    await waitForPlayback(ch, 'player on live stream A');
    await twoLive.bringToFront();
    const addPopup = await openPopup(twoLive);
    await (await (await itemFor(addPopup, 'b/master.m3u8')).$('button::-p-text(Add to player)')).click();
    const addStatus = await addPopup.$eval('#status', (el) => el.textContent).catch(() => '(popup closed)');
    await ch.bringToFront();
    await ch
      .waitForFunction(() => [...document.querySelectorAll('video')].filter((v) => !v.hidden && v.currentTime >= 1).length === 2, {
        timeout: 20000,
        polling: 250,
      })
      .catch(async (err) => {
        const state = await ch.evaluate(() => ({
          videos: [...document.querySelectorAll('video')].map((v) => ({ hidden: v.hidden, t: v.currentTime, paused: v.paused })),
          problems: document.getElementById('problems')?.textContent,
        }));
        throw new Error(`both live streams never played in one player: ${JSON.stringify(state)}; popup said "${addStatus}" (${err.message})`);
      });
    ok('the player plays live stream A big and live stream B small');

    await ch.click('::-p-aria(Settings)');
    await ch.click('button::-p-text(Cast via relay)');
    const chFrame = await ch.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 15000 });
    const chMedia = (await waitForText(chFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    const playing = await ch.$$eval('video', (vs) => vs.filter((v) => !v.hidden && !v.paused).length);
    assert(playing === 0, `the tab stops both of its own videos while the TV plays them (${playing} still playing)`);

    const pl1 = await readPlaylist(chMedia);
    assert(pl1.live && pl1.entries.length >= 2, `the TV gets one live playlist (${pl1.entries.length} segments, no end tag)`);
    assert((await lastStream(pl1)) === 'A', 'it plays the big stream, A');
    await new Promise((r) => setTimeout(r, 2500)); // a live refresh, before swapping
    const pl1b = await readPlaylist(chMedia);
    assertConsistent(pl1, pl1b, 'a plain refresh');
    assert(pl1b.entries.at(-1).seq > pl1.entries.at(-1).seq, `new live segments keep arriving (${pl1.entries.at(-1).seq} -> ${pl1b.entries.at(-1).seq})`);

    const pl2 = await swapTo(chFrame, pl1b, 'B');
    ok('after Swap on TV, the playlist continues with stream B after a discontinuity');
    assertConsistent(pl1b, pl2, 'the swap to B');
    await waitForText(chFrame, /On TV:.*b\/master\.m3u8/);
    ok('the cast controls say B is on the TV');

    const pl3 = await swapTo(chFrame, pl2, 'A');
    ok('swapping again goes back to stream A');
    assertConsistent(pl2, pl3, 'the swap back to A');
    // The relay runs with a 4-segment window here, so the first swap scrolls off the top.
    let pl4 = pl3;
    for (const deadline = Date.now() + 15000; pl4.discSeq < 1; ) {
      if (Date.now() > deadline) throw new Error(`the first swap never scrolled off the TV's playlist:\n${pl4.text}`);
      await new Promise((r) => setTimeout(r, 1000));
      pl4 = await readPlaylist(chMedia);
    }
    assert(pl4.seq > pl1.seq, `old segments scroll off as live goes on (media sequence ${pl1.seq} -> ${pl4.seq})`);
    assertConsistent(pl3, pl4, 'after a swap scrolls off the top');
    await ch.close();
    await twoLive.close();

    // A real stream's source paused for 11 s (Nov 2026) while the TV sat 2 s behind its newest
    // segment, so the TV buffered. The relay keeps a few segments in reserve and hands them over
    // at the pace they play, so a short pause at the source never reaches the TV.
    step('One live stream: a pause at its source does not stop new segments reaching the TV');
    const steady = await browser.newPage();
    await steady.goto(`chrome-extension://${ext.id}/player.html`);
    await steady.type('input[name=url]', MASTER_URL.replace('/live/', '/live/stall/'));
    await steady.type('input[name=referer]', EMBED + '/');
    await steady.click('button::-p-text(Play)');
    await waitForPlayback(steady, 'player on the pausing live stream');
    // Manual mode leaves the ⚙ menu open (it holds the URL form), so the relay button is in view.
    await steady.click('button::-p-text(Cast via relay)');
    const steadyFrame = await steady.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 15000 });
    let steadyMedia = (await waitForText(steadyFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    // Like the TV, follow a master playlist to the variant it plays.
    const firstLoad = await (await tvGet(steadyMedia)).text();
    if (firstLoad.includes('#EXT-X-STREAM-INF')) steadyMedia = new URL(firstUri(firstLoad), steadyMedia).href;
    let tvPl = await readPlaylist(steadyMedia);
    assert(tvPl.live && tvPl.entries.length >= 2, `the TV gets a live playlist (${tvPl.entries.length} segments)`);
    // Reads the TV's playlist every 0.5 s for ms, and returns the longest time it went without a
    // new segment. Measured by the clock, so a TV request that itself waits counts as time
    // without video.
    const longestTvGap = async (ms, what) => {
      let longest = 0;
      let lastGrowth = Date.now();
      const start = Date.now();
      while (Date.now() - start < ms) {
        await new Promise((r) => setTimeout(r, 500));
        const now = await readPlaylist(steadyMedia);
        assertConsistent(tvPl, now, what, { quiet: true });
        if (now.entries.at(-1).seq > tvPl.entries.at(-1).seq) {
          longest = Math.max(longest, Date.now() - lastGrowth);
          lastGrowth = Date.now();
        }
        tvPl = now;
      }
      return Math.max(longest, Date.now() - lastGrowth);
    };
    // The fixture's segments are 2 s long, so the TV normally gets one every 2 s.
    servers.stallLive(7000);
    // Long enough for the pause to reach the TV even if it arrives late (after the reserve).
    const pauseGap = await longestTvGap(20000, 'a refresh around a pause at the source');
    assert(pauseGap < 5000, `over 20 s from the start of a 7 s pause at the source, the TV's playlist never went more than 5 s without a new segment (longest: ${(pauseGap / 1000).toFixed(1)} s)`);
    assert((await lastStream(tvPl)) === 'A', 'the newest segment the TV sees is real video from the stream');
    const reserveNote = await waitForText(steadyFrame, /Reserve: \d+ s of video \(keeps up to \d+ s\)/);
    ok(`the cast controls say how much video is in reserve now: "${reserveNote}"`);

    // A real stream's playlist server sometimes never answered one request (Nov 2026); the relay
    // waited 20 s for it while the TV ran dry.
    step('One live stream: a playlist request the source never answers does not stall the TV');
    servers.hangNextPlaylist();
    const hangGap = await longestTvGap(20000, 'a refresh around a hung playlist request');
    assert(hangGap < 5000, `over 20 s around a hung playlist request, the TV's playlist never went more than 5 s without a new segment (longest: ${(hangGap / 1000).toFixed(1)} s)`);
    await steady.close();

    step('Manual mode: paste URL + Referer into the player page');
    const manual = await browser.newPage();
    await manual.goto(`chrome-extension://${ext.id}/player.html`);
    await manual.type('input[name=url]', MASTER_URL);
    await manual.type('input[name=referer]', EMBED + '/');
    await manual.click('button::-p-text(Play)');
    const manualTime = await waitForPlayback(manual, 'manual player');
    ok(`manual mode plays (t=${manualTime.toFixed(1)}s)`);

    step('A playlist the server garbles shows why it failed and what the server sent');
    const garbled = await browser.newPage();
    await garbled.goto(`chrome-extension://${ext.id}/player.html`);
    await garbled.type('input[name=url]', MASTER_URL.replace('/live/', '/live/broken/'));
    await garbled.type('input[name=referer]', EMBED + '/');
    await garbled.click('button::-p-text(Play)');
    // A garbled reply is retried like a failed load, so this takes a few seconds.
    await garbled.waitForFunction(() => /Stopped/.test(document.getElementById('problems').textContent), {
      timeout: 30000,
      polling: 250,
    });
    const garbledShort = await garbled.$eval('#problems', (p) => p.textContent);
    assert(
      garbledShort.length < 120 && !/Buffering|Reconnecting/.test(garbledShort),
      `over the video, one short line says it stopped ("${garbledShort}")`
    );
    await garbled.click('summary::-p-text(Details)');
    const garbledMsg = await waitForText(garbled, /EXTM3U.*503 Service Unavailable/);
    ok(`the stream's details in the menu say what the server sent: "${garbledMsg}"`);

    step('A live stream whose segment URLs change on every refresh keeps playing, and the player says what it skipped');
    const rot = await browser.newPage();
    await rot.goto(`chrome-extension://${ext.id}/player.html`);
    await rot.type('input[name=url]', MASTER_URL.replace('/live/', '/live/rot/'));
    await rot.type('input[name=referer]', EMBED + '/');
    await rot.click('button::-p-text(Play)');
    const rotStart = await waitForPlayback(rot, 'rotating live stream', 0.1);
    // The first playlist holds 6 s; playing 9 s more needs refreshes with the new URLs.
    const rotEnd = await waitForPlayback(rot, 'rotating live stream after refreshes', rotStart + 9, 30000);
    ok(`kept playing across refreshes (${rotStart.toFixed(1)}s -> ${rotEnd.toFixed(1)}s)`);
    await rot.click('summary::-p-text(Details)');
    const rotNote = await waitForText(rot, /skipped \d+ playlist problems?.*media sequence mismatch/);
    ok(`the stream's details say: "${rotNote.slice(0, 160)}…"`);

    step('A playlist refresh that fails once shows while it is retried, then clears; a pause is undone');
    const flaky = await browser.newPage();
    await flaky.goto(`chrome-extension://${ext.id}/player.html`);
    await flaky.type('input[name=url]', MASTER_URL.replace('/live/', '/live/flaky/'));
    await flaky.type('input[name=referer]', EMBED + '/');
    await flaky.click('button::-p-text(Play)');
    await flaky.click('::-p-aria(Settings)'); // close the menu; problems show over the video
    // Mutation polling sees the line however briefly it shows.
    const overlay = (re) =>
      flaky.waitForFunction((src) => new RegExp(src).test(document.getElementById('problems').textContent), {
        timeout: 20000,
        polling: 'mutation',
      }, re.source);
    await overlay(/503/);
    ok('the failed refresh shows over the video while it is retried');
    await flaky.waitForFunction(() => !document.getElementById('problems').textContent, { timeout: 15000, polling: 250 });
    const flakyT = await flaky.evaluate(() => document.querySelector('video').currentTime);
    await waitForPlayback(flaky, 'flaky live stream after the retry', flakyT + 2);
    ok('it clears once the next refresh works, and playback goes on');

    // Live streams just play: a pause, from the controls or the browser, is undone and noted.
    await flaky.focus('video');
    await flaky.keyboard.press('Space'); // the video's own pause key
    const pausedT = await flaky.evaluate(() => document.querySelector('video').currentTime);
    await waitForPlayback(flaky, 'flaky live stream after a pause', pausedT + 1, 5000);
    await flaky.click('::-p-aria(Settings)');
    await flaky.click('summary::-p-text(Details)');
    const resumeNote = await waitForText(flaky, /resumed after 1 pause/i);
    ok(`a pause is undone at once and noted in the status: "${resumeNote.slice(0, 160)}"`);
    await flaky.close();

    step('Manual mode without a Referer fails loudly, not silently');
    const bad = await browser.newPage();
    await bad.goto(`chrome-extension://${ext.id}/player.html`);
    await bad.type('input[name=url]', MASTER_URL);
    await bad.click('button::-p-text(Play)');
    await bad.waitForSelector('::-p-text(403)', { timeout: 10000 });
    ok('player shows the 403 error to the user');
    await bad.screenshot({ path: path.join(artifactsDir, 'player-403.png') });

    step('"Cast via relay" with headers the CDN rejects reports the 403 instead of casting a dead URL');
    await bad.click('button::-p-text(Cast via relay)');
    const badRelayMsg = await waitForText(bad, /^Relay:.*403/);
    ok(`player reports: "${badRelayMsg}"`);

  } finally {
    if (relay) relay.kill();
    if (browser) await browser.close();
    await servers.close();
  }
  // Printed only after cleanup, so PASS means the run also finished cleanly.
  console.log(`\nPASS — all checks passed. Screenshots in ${artifactsDir}`);
  process.exitCode = 0;
}

// A hang must fail loudly too, not leave the run sitting there.
const watchdog = setTimeout(() => {
  console.error('\nFAIL — test did not finish within 180s (hung)');
  process.exit(1);
}, 180000);
watchdog.unref();

main().catch((err) => {
  console.error(`\nFAIL — ${err.stack || err}`);
  process.exit(1);
});
