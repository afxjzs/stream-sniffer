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
import { startServers, SITE, EMBED, MASTER_URL } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const streamDir = path.join(here, 'fixtures/stream');
const artifactsDir = path.join(here, 'artifacts');
const relayPath = path.resolve(here, '../relay/server.mjs');
const RELAY = 'http://localhost:8788';
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
    const proc = spawn('node', [relayPath], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      throw new Error(`something is already running on ${RELAY} (${strayRelay.slice(0, 60)}). Stop your relay before running the test.`);
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
    await player.screenshot({ path: path.join(artifactsDir, 'player-from-popup.png') });

    step('Player has a one-click Cast button that reports what happened');
    // Headless Chrome has no cast devices, so the outcome we can check is that clicking
    // the button tells the user something instead of doing nothing.
    const castBtn = await player.waitForSelector('button::-p-text(Cast via Chrome)', { visible: true, timeout: 5000 });
    assert(castBtn, '"Cast via Chrome" button is visible on the player page');
    await castBtn.click();
    // Wait for the outcome, not the in-progress "…" message.
    const castMsg = await (
      await player.waitForFunction(
        () => {
          const el = [...document.querySelectorAll('body *')].find(
            (e) => e.children.length === 0 && e.textContent.startsWith('Cast:')
          );
          return el && !el.textContent.endsWith('…') ? el.textContent : false;
        },
        { timeout: 10000, polling: 100 }
      )
    ).jsonValue();
    ok(`clicking Cast reports: "${castMsg}"`);
    await player.screenshot({ path: path.join(artifactsDir, 'player-cast.png') });

    step('"Cast via relay" without the relay running says how to start it');
    await player.click('button::-p-text(Cast via relay)');
    const noRelayMsg = await waitForText(player, /^Relay:.*relay\/server\.mjs/);
    ok(`player reports: "${noRelayMsg}"`);

    step('Start the relay; "Cast via relay" opens its cast page with a LAN address for the TV');
    relay = await startRelay();
    const castTargetP = browser.waitForTarget((t) => t.url().startsWith(`${RELAY}/cast/`), { timeout: 10000 });
    await player.click('button::-p-text(Cast via relay)');
    const castPage = await (await castTargetP).asPage();
    const mediaText = await waitForText(castPage, /http:\/\/[\d.]+:8788\/\S+/);
    const mediaUrl = mediaText.match(/http:\/\/[\d.]+:8788\/\S+/)[0];
    ok(`cast page shows the URL the Chromecast will load: ${mediaUrl}`);
    assert(!/^http:\/\/127\./.test(mediaUrl), 'that URL is a LAN address, not loopback (the TV must reach it)');
    await castPage.screenshot({ path: path.join(artifactsDir, 'cast-page.png') });

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

    step('Manual mode: paste URL + Referer into the player page');
    const manual = await browser.newPage();
    await manual.goto(`chrome-extension://${ext.id}/player.html`);
    await manual.type('input[name=url]', MASTER_URL);
    await manual.type('input[name=referer]', EMBED + '/');
    await manual.click('::-p-text(Play)');
    const manualTime = await waitForPlayback(manual, 'manual player');
    ok(`manual mode plays (t=${manualTime.toFixed(1)}s)`);

    step('Manual mode without a Referer fails loudly, not silently');
    const bad = await browser.newPage();
    await bad.goto(`chrome-extension://${ext.id}/player.html`);
    await bad.type('input[name=url]', MASTER_URL);
    await bad.click('::-p-text(Play)');
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
