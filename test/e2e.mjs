// End-to-end test: load the unpacked extension in Chrome for Testing, visit a fake stream
// site, and check what a user can see and do: the popup lists the captured stream, the
// VLC command carries headers the CDN accepts, and the built-in player actually plays it.
//
// Run: cd test && npm install && npm test
// Artifacts (screenshots) land in test/artifacts/.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServers, SITE, EMBED, MASTER_URL, CDN2_MASTER_URL } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const streamDir = path.join(here, 'fixtures/stream');
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

function ensureStream() {
  if (fs.existsSync(path.join(streamDir, 'index.m3u8'))) return;
  step('Generating test HLS stream with ffmpeg');
  fs.mkdirSync(streamDir, { recursive: true });
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50',
      '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(streamDir, 'seg%d.ts'),
      path.join(streamDir, 'index.m3u8'),
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

// Waits until some leaf element's text matches the regex; returns that text.
async function waitForText(page, re, timeoutMs = 10000) {
  const handle = await page.waitForFunction(
    (src, flags) => {
      const rx = new RegExp(src, flags);
      const el = [...document.querySelectorAll('body *')].find(
        (e) => e.children.length === 0 && rx.test(e.textContent)
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
      env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
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
  ensureStream();
  fs.mkdirSync(artifactsDir, { recursive: true });

  const servers = await startServers({
    streamDir,
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

    step('The VLC command shown in the popup carries headers the CDN accepts');
    const vlcCmd = await popup.$eval('::-p-text(--http-referrer)', (el) => el.textContent);
    console.log(`  command: ${vlcCmd}`);
    const referrer = vlcCmd.match(/--http-referrer='([^']+)'/)?.[1];
    const cmdUrl = vlcCmd.match(/'(https?:\/\/[^']*master\.m3u8[^']*)'/)?.[1];
    assert(cmdUrl === MASTER_URL, `command has the master playlist URL (${cmdUrl})`);
    const viaCmd = await fetch(cmdUrl, { headers: { referer: referrer } });
    assert(viaCmd.status === 200, `fetching with the command's referrer -> 200 (got ${viaCmd.status})`);

    step('The curl command shown in the popup replays the browser request exactly');
    const curlCmd = await popup.$eval('::-p-text(curl )', (el) => el.textContent);
    assert(curlCmd.includes('master.m3u8'), 'popup shows a curl command for the master playlist');
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
    let masterItem = null;
    for (const li of await popup.$$('li')) {
      if ((await li.evaluate((el) => el.textContent)).includes('master.m3u8')) masterItem = li;
    }
    assert(masterItem, 'popup has a list entry for master.m3u8');
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
    const sourceText = await waitForText(player, /Fake Sports Site/, 5000);
    assert(
      (await player.$eval('a[href]', (a) => a.href).catch(() => '')) === SITE + '/',
      `player shows where the stream came from ("${sourceText}", linked to ${SITE}/)`
    );
    assert((await player.title()).includes('Fake Sports Site'), `player tab title names the source page ("${await player.title()}")`);
    await player.screenshot({ path: path.join(artifactsDir, 'player-from-popup.png') });

    step('The video fills the tab; the controls sit behind a settings button');
    const fills = await player.$eval('video', (v) => {
      const r = v.getBoundingClientRect();
      return r.width === innerWidth && r.height === innerHeight;
    });
    assert(fills, 'video covers the whole tab');
    await player.click('::-p-aria(Settings)');
    await player.waitForSelector('input[name=url]', { visible: true, timeout: 5000 });
    ok('settings menu shows the stream form');

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
    await popup3.waitForSelector(`::-p-text(${CDN2_MASTER_URL})`, { timeout: 5000 });
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
    const garbledMsg = await waitForText(garbled, /Playback failed.*EXTM3U.*503 Service Unavailable/, 30000);
    ok(`player reports: "${garbledMsg}"`);

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
    const rotNote = await waitForText(rot, /skipped \d+ playlist problems?.*media sequence mismatch/);
    ok(`stream status says: "${rotNote.slice(0, 160)}…"`);

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
  console.error('\nFAIL — test did not finish within 120s (hung)');
  process.exit(1);
}, 120000);
watchdog.unref();

main().catch((err) => {
  console.error(`\nFAIL — ${err.stack || err}`);
  process.exit(1);
});
