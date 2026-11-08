// End-to-end test: load the unpacked extension in Chrome for Testing, visit a fake stream
// site, and check what a user can see and do: the popup lists the captured stream, the
// VLC command carries headers the CDN accepts, and the built-in player actually plays it.
//
// Run: cd test && npm install && npm test
// Artifacts (screenshots) land in test/artifacts/.
import puppeteer from 'puppeteer-core';
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

// The test video; a second stream with a different picture (streamDirB), so a test can tell
// which one reached the TV; a 1280x720 copy (hi/) for the stream with two quality levels; and a
// copy with uneven frame timestamps (jitter/): every fourth frame 0.45 of a frame late, as
// relayed re-streams often have.
function ensureStreams() {
  makeStream(streamDir, '320x240');
  // Its timestamps start an hour later, like a second real channel's: unrelated to stream A's.
  makeStream(streamDirB, '320x240', ['-output_ts_offset', '3600'], { pattern: 'testsrc2', tone: 880 });
  makeStream(path.join(streamDir, 'hi'), '1280x720');
  makeStream(path.join(streamDir, 'jitter'), '320x240', [
    '-vf', "settb=1/90000,setpts='(N+if(eq(mod(N\\,4)\\,1)\\,0.45\\,0))/25/TB'",
    '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-bf', '0',
  ]);
}
// Reads a live HLS address the way Jellyfin's Live TV does: ffmpeg with the flags from its log
// (Nov 2026), remuxing to fMP4 HLS. grows(n, ms, what) waits for n more video frames and fails,
// with ffmpeg's last words, if they don't come within ms.
const readers = [];
function startJellyfinReader(url) {
  const out = fs.mkdtempSync(path.join(artifactsDir, 'jellyfin-reader-'));
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1',
    '-analyzeduration', '3000000', '-probesize', '1G',
    '-re', '-readrate_catchup', '100', '-fflags', '+igndts+genpts', '-f', 'hls', '-i', url,
    '-map_metadata', '-1', '-sn', '-codec:v:0', 'copy', '-start_at_zero', '-codec:a:0', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-copyts', '-avoid_negative_ts', 'disabled', '-max_muxing_queue_size', '2048',
    '-f', 'hls', '-max_delay', '5000000', '-hls_time', '3', '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'event', '-hls_list_size', '0', path.join(out, 'out.m3u8'),
  ]);
  const reader = { frames: 0, log: '', exited: null };
  proc.stdout.on('data', (d) => {
    for (const [, n] of String(d).matchAll(/^frame=(\d+)/gm)) reader.frames = Number(n);
  });
  // Everything ffmpeg says (which segments it opens, what it rejects) goes to ffmpeg.log there.
  const logFile = fs.createWriteStream(path.join(out, 'ffmpeg.log'));
  proc.stderr.on('data', (d) => {
    logFile.write(d);
    reader.log = (reader.log + d).slice(-1500);
  });
  proc.on('exit', (code, signal) => (reader.exited = code ?? signal));
  reader.stop = () => proc.exitCode == null && proc.kill('SIGKILL');
  reader.grows = async (n, ms, what) => {
    const from = reader.frames;
    const deadline = Date.now() + ms;
    while (reader.frames < from + n) {
      if (reader.exited != null || Date.now() > deadline) {
        throw new Error(
          `ASSERTION FAILED: a Jellyfin-style ffmpeg reader of ${url} keeps getting video ${what}: it went from frame ${from} to ${reader.frames} in ${ms / 1000} s${reader.exited != null ? ` and exited (${reader.exited})` : ''}. Full ffmpeg log: ${path.join(out, 'ffmpeg.log')}. It ended with:\n${reader.log}`
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    ok(`a Jellyfin-style ffmpeg reader keeps getting video ${what} (frame ${from} -> ${reader.frames})`);
  };
  readers.push(reader);
  return reader;
}

// Regenerates the stream when the arguments it was made with change (recorded in made-with.json).
function makeStream(dir, size, videoArgs = [], { pattern = 'testsrc', tone = 440 } = {}) {
  const madeWith = JSON.stringify({ size, videoArgs, pattern, tone });
  const stamp = path.join(dir, 'made-with.json');
  if (fs.existsSync(path.join(dir, 'index.m3u8')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === madeWith) return;
  step(`Generating ${size} test HLS stream in ${path.relative(path.dirname(streamDir), dir)} with ffmpeg`);
  // Only this stream's own files: hi/ and jitter/ live inside the main stream's folder.
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^seg\d+\.ts$|^index\.m3u8$|^made-with\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `${pattern}=size=${size}:rate=25`,
      '-f', 'lavfi', '-i', `sine=frequency=${tone}`,
      '-t', '20',
      ...videoArgs,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50',
      '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
      path.join(dir, 'index.m3u8'),
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed with exit code ${r.status} (${r.error ?? ''})`);
  fs.writeFileSync(stamp, madeWith);
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

// Reports a fatal network error on the page's big stream, as hls.js does once its own retries
// of a segment give up.
const failSegment = (page) =>
  page.evaluate(() =>
    streams[0].hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR, fatal: true })
  );

// Clicks Start casting in the player's menu (opening the menu if it's closed).
async function startCasting(page) {
  // Clicks wait for the page to draw a frame, which a background tab doesn't.
  await page.bringToFront();
  if (await page.$eval('#menu', (m) => m.hidden)) await page.click('::-p-aria(Settings)');
  await page.click('button::-p-text(Start casting)');
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
    // What the relay's terminal shows: casts it has replaced, and errors it printed after that
    // about one of them (a replaced cast is done; an error about it is a false alarm).
    proc.replaced = new Set();
    proc.errorsAfterReplaced = [];
    proc.stdout.on('data', (d) => {
      process.stdout.write(`    [relay] ${d}`);
      for (const [, id] of String(d).matchAll(/\[relay\] (\w+): superseded/g)) proc.replaced.add(id);
      // The short address it tells you to type into a TV app.
      proc.nowUrl ??= String(d).match(/http:\/\/\S+\/now\.m3u8/)?.[0];
      if (String(d).includes('[relay] ready')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (d) => {
      process.stdout.write(`    [relay:err] ${d}`);
      for (const line of String(d).split('\n')) {
        const id = line.match(/\[relay\] (\w+):/)?.[1];
        if (id && proc.replaced.has(id)) proc.errorsAfterReplaced.push(line);
      }
    });
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

    // The installed Chrome, which keeps itself up to date, rather than the Chrome for Testing
    // build Puppeteer pins: that one only moves when Puppeteer is upgraded, and fell two major
    // versions (and their security fixes) behind. Chrome's sandbox stays on.
    step('Launch the installed Chrome with the extension');
    browser = await puppeteer.launch({ channel: 'chrome', headless: HEADLESS, pipe: true, enableExtensions: [extDir] });
    console.log(`  browser: ${await browser.version()} (the installed Chrome)`);
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

    step('The popup says what each playlist offers; "Check quality" measures it');
    // The fixture master lists one quality (320x240, 400 kbps), whose playlist is a finished video.
    const rejectedBefore = servers.rejected.length;
    const masterInfo = await waitForText(popup, /^1 quality: 240p · 400 kbps advertised · not live$/, 10000);
    ok(`master playlist: "${masterInfo}"`);
    let masterItem = null;
    for (const li of await popup.$$('li')) {
      if ((await li.evaluate((el) => el.textContent)).includes('live/master.m3u8')) masterItem = li;
    }
    assert(masterItem, 'popup has a list entry for master.m3u8');
    await (await masterItem.$('button::-p-text(Check quality)')).click();
    const checked = await waitForText(popup, /^(Checked|Couldn't check)/, 30000);
    assert(/^Checked: 240p25 · \d+ kbps measured$/.test(checked), `check reports resolution, frame rate and measured bitrate ("${checked}")`);
    assert(servers.rejected.length === rejectedBefore, `the CDN accepted the popup's requests (${JSON.stringify(servers.rejected.slice(rejectedBefore))})`);
    const popupRules = await sw.evaluate(async () =>
      (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.condition.tabIds?.includes(chrome.tabs.TAB_ID_NONE)).length
    );
    assert(popupRules === 0, `the popup's header rules are gone once it's done (${popupRules} left)`);
    await popup.screenshot({ path: path.join(artifactsDir, 'popup.png') });

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
    await player.waitForSelector('input[name=url]', { visible: true, timeout: 5000 });
    ok('settings menu shows the stream form');
    await player.click('#play-url summary');
    // Puppeteer's { hidden: true } doesn't see inside a closed <details>; checkVisibility does.
    await player.waitForFunction(() => !document.querySelector('input[name=url]').checkVisibility(), { timeout: 5000 });
    ok('"Play a URL" folds away');
    await player.reload();
    await waitForPlayback(player, 'extension player after a reload', 0.5);
    await player.click('::-p-aria(Settings)');
    assert(await player.$eval('#play-url', (d) => !d.open), '"Play a URL" is still folded after a reload');
    await player.click('#play-url summary');
    await player.waitForSelector('input[name=url]', { visible: true, timeout: 5000 });
    ok('and opens again with a click');

    step('"Pop out" puts the video in a floating picture-in-picture window, and can bring it back');
    await player.click('::-p-aria(Pop out)');
    await player.waitForFunction(() => document.pictureInPictureElement?.tagName === 'VIDEO', { timeout: 5000 });
    ok('video is in picture-in-picture');
    await player.click('::-p-aria(Back to tab)');
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
    await player.keyboard.press('s');
    [a, b] = await sizes();
    assert(b.area > a.area * 4 && !b.muted && a.muted, 'S swaps them too, sound included');
    await player.keyboard.press('s');
    [a, b] = await sizes();
    assert(a.area > b.area * 4, 'and S again swaps back');

    // Moving and resizing both pictures makes Chrome skip a frame or two, which isn't a problem
    // worth a warning (seen Nov 2026: one after every swap). Chrome's skipped-frame count is the
    // outside world here, and real Chrome adds its own now and then, so from here on this page
    // reports only the test's count: 2 more for each picture whenever the test says.
    await player.evaluate(() => {
      window.extraDrops = 0;
      for (const v of document.querySelectorAll('video')) {
        const real = v.getVideoPlaybackQuality.bind(v);
        v.getVideoPlaybackQuality = () => ({ ...real(), droppedVideoFrames: window.extraDrops });
      }
    });
    // Frames real Chrome skipped before that leave the warning's 10 s window first.
    await player.waitForFunction(() => !/Frames in the last 10 s/.test(document.getElementById('problems').textContent), { timeout: 15000 });
    const framesWarned = () => player.$eval('#problems', (e) => /Frames in the last 10 s/.test(e.textContent));
    await player.keyboard.press('s');
    await player.evaluate(() => (window.extraDrops += 2));
    await new Promise((r) => setTimeout(r, 3000)); // the count runs once a second
    const afterSwap = await player.$eval('#problems', (e) => e.textContent);
    assert(!/Frames in the last 10 s/.test(afterSwap), `a swap that makes Chrome skip a couple of frames shows no lost-frames warning (over the video: "${afterSwap}")`);
    await player.evaluate(() => (window.extraDrops += 2));
    await player.waitForFunction(() => /Frames in the last 10 s/.test(document.getElementById('problems').textContent), { timeout: 5000 });
    ok('the same skipped frames without a swap still show the warning');
    await player.click('#problems p.warn .dismiss'); // hidden until the drops stop
    await player.keyboard.press('s');
    [a, b] = await sizes();
    assert(a.area > b.area * 4, 'and S swaps back');

    // Hiding the small picture keeps its stream playing, and S still swaps.
    const smallState = () =>
      player.$eval('video.small', (v) => ({ shown: v.checkVisibility({ visibilityProperty: true }), t: v.currentTime, muted: v.muted }));
    const bigSrc = await player.$eval('video.big', (v) => v.src);
    await player.click('::-p-aria(Hide the small picture)');
    const tucked = await smallState();
    assert(!tucked.shown, 'the – on the small picture hides it');
    await player.waitForFunction((t) => document.querySelector('video.small').currentTime >= t + 1, { timeout: 5000, polling: 250 }, tucked.t);
    ok('its stream keeps playing while hidden');
    await player.keyboard.press('s');
    assert((await player.$eval('video.big', (v) => v.src)) !== bigSrc, 'S still swaps while it is hidden');
    assert(!(await smallState()).shown && (await smallState()).muted, 'and the stream swapped out is the hidden, muted one');
    await player.keyboard.press('s');
    await player.click('::-p-aria(Show small picture)');
    assert((await smallState()).shown, '"Show small picture" in the bar brings it back');
    await player.keyboard.press('h');
    assert(!(await smallState()).shown, 'H hides it');
    await player.keyboard.press('h');
    assert((await smallState()).shown, 'and H shows it again');

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

    // The test video is 320x240 at 25 fps. The frame rate takes 2 s of video to count.
    const barLabel = await player
      .waitForFunction(
        () => {
          const text = document.getElementById('quality').textContent;
          return /^240p25·?\d+(\.\d)? (Mbps|kbps)$/.test(text) && text;
        },
        { timeout: 10000, polling: 250 }
      )
      .then((h) => h.jsonValue())
      .catch(async (err) => {
        throw new Error(`bar label is "${await player.$eval('#quality', (e) => e.textContent)}": ${err.message}`);
      });
    ok(`the bar shows the big picture's resolution, frame rate and measured bitrate ("${barLabel}")`);
    const bothShowing = () => player.$$eval('video', (vs) => vs.filter((v) => !v.hidden && v.checkVisibility()).length === 2);
    await player.click('::-p-aria(Full screen)');
    await player.waitForFunction(() => document.fullscreenElement === document.documentElement, { timeout: 5000 });
    assert(await bothShowing(), 'the full-screen button fills the screen with the whole player, so the small picture stays');
    await player.keyboard.press('f');
    await player.waitForFunction(() => !document.fullscreenElement, { timeout: 5000 });
    ok('F leaves full screen');
    await (await player.$('video.big')).click({ count: 2 });
    await player.waitForFunction(() => document.fullscreenElement === document.documentElement, { timeout: 5000 });
    assert(await bothShowing(), 'double-clicking the big picture does the same');
    await player.keyboard.press('f');
    await player.waitForFunction(() => !document.fullscreenElement, { timeout: 5000 });
    await player.click('::-p-aria(Mute)');
    assert(await player.$eval('video.big', (v) => v.muted), "the bar's speaker button mutes the big picture");
    await player.keyboard.press('m');
    assert(!(await player.$eval('video.big', (v) => v.muted)), 'and M unmutes it');
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

    step('"Cast via relay" stays in view with "Play a URL" folded; without the relay running it says how to start it');
    if (await player.$eval('#play-url', (d) => d.open)) await player.click('#play-url summary');
    await player.waitForFunction(() => !document.querySelector('input[name=url]').checkVisibility(), { timeout: 5000 });
    assert(
      await player.$eval('#relay', (b) => b.checkVisibility() && b.textContent === 'Start casting'),
      'Start casting shows in the menu while "Play a URL" is folded'
    );
    await startCasting(player);
    const noRelayMsg = await waitForText(player, /^Relay:.*relay\/server\.mjs/);
    ok(`player reports: "${noRelayMsg}"`);

    step('Start the relay; "Cast via relay" shows the cast controls inside the player, with a LAN address for the TV');
    relay = await startRelay();
    // The short address someone types into a TV app. Before any cast, it says what to do.
    const nowUrl = relay.nowUrl;
    assert(nowUrl && !/^http:\/\/(127\.|\[|localhost)/.test(nowUrl), `the relay prints a short LAN address for TV apps (${nowUrl})`);
    const noCast = await fetch(nowUrl);
    const noCastText = await noCast.text();
    assert(noCast.status === 404 && /Start casting/.test(noCastText), `${nowUrl} before any cast -> 404 saying to press Start casting (${noCast.status}: ${noCastText})`);
    await startCasting(player);
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

    step('A short fixed address on the LAN, /now.m3u8, plays the current cast');
    const nowRes = await fetch(nowUrl);
    const nowText = await nowRes.text();
    assert(nowRes.status === 200 && nowText === (await (await fetch(mediaUrl)).text()), `${nowUrl} serves the cast's playlist (${nowRes.status})`);
    const nowSeg = new URL(firstUri(await (await fetch(new URL(firstUri(nowText), nowRes.url))).text()), nowRes.url);
    const nowSegBytes = new Uint8Array(await (await fetch(nowSeg)).arrayBuffer());
    assert(nowSegBytes[0] === 0x47, `links in it lead to real video (${nowSegBytes.length} bytes from ${nowSeg.pathname.slice(0, 30)}…)`);

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
    await startCasting(trickyPlayer);
    const trickyFrame = await trickyPlayer.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 10000 });
    const trickyMedia = (await waitForText(trickyFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    const tMaster = await (await fetch(trickyMedia)).text();
    const nowAfter = await (await fetch(nowUrl)).text();
    assert(nowAfter === tMaster && nowAfter !== nowText, `after a new cast, ${nowUrl} serves the new cast, not the replaced one`);
    const tVariantUrl = new URL(firstUri(tMaster), trickyMedia).href;
    const tSegUrl = new URL(firstUri(await (await fetch(tVariantUrl)).text()), tVariantUrl).href;
    const tSeg = await fetch(tSegUrl);
    const tBytes = new Uint8Array(await tSeg.arrayBuffer());
    assert(
      tSeg.status === 200 && tBytes[0] === 0x47 && tSeg.headers.get('content-type') === 'video/mp2t',
      `relay hands the TV plain MPEG-TS, not the PNG wrapper (${tSeg.status}, first byte 0x${tBytes[0]?.toString(16)}, ${tSeg.headers.get('content-type')})`
    );
    // Players built on ffmpeg (Jellyfin's Live TV, VLC) refuse segment URLs that don't end in a
    // media extension, and this site names its segments seg1.image (as a real one did).
    // Async: the test site's servers run in this process and must keep answering meanwhile.
    const probe = await new Promise((resolve) =>
      execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', trickyMedia], { timeout: 30000 }, (err, stdout, stderr) =>
        resolve({ code: err ? (err.code ?? err.signal) : 0, stdout: stdout.trim(), stderr: stderr.trim() })
      )
    );
    assert(
      probe.code === 0 && probe.stdout !== '' && probe.stdout.split(/\s+/).every((c) => c === 'h264'),
      `ffprobe (what Jellyfin uses) reads the cast's video (exit ${probe.code}, "${probe.stdout}"${probe.stderr ? `, ${probe.stderr.slice(0, 300)}` : ''})`
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
    await startCasting(webp);
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
    await startCasting(gif);
    const gifMsg = await waitForText(gif, /^Relay:.*image/i, 15000);
    ok(`player reports: "${gifMsg}"`);
    const gifFrames = gif.frames().filter((f) => f.url().startsWith(`${RELAY}/cast/`));
    assert(gifFrames.length === 0, 'no cast controls are offered for it');
    await gif.close();

    step('Swap on TV: two live streams cast as one channel, and Swap switches what the TV gets');
    // The relay moves the TV's segments onto one clock, so a segment is recognized by its
    // contents with every timestamp (PTS, DTS, PCR) blanked out. Written apart from the relay's
    // own parser on purpose.
    const withoutTimestamps = (src) => {
      const b = Buffer.from(src);
      for (let p = 0; p + 188 <= b.length; p += 188) {
        const afc = (b[p + 3] >> 4) & 3;
        let pay = p + 4;
        if (afc & 2) {
          if (b[p + 4] > 0 && b[p + 5] & 0x10) b.fill(0, p + 6, p + 12);
          pay = p + 5 + b[p + 4];
        }
        if (afc & 1 && b[p + 1] & 0x40 && pay + 19 <= p + 188 && b[pay] === 0 && b[pay + 1] === 0 && b[pay + 2] === 1) {
          const flags = b[pay + 7] >> 6;
          if (flags & 2) b.fill(0, pay + 9, pay + 14);
          if (flags === 3) b.fill(0, pay + 14, pay + 19);
        }
      }
      return b;
    };
    const hash = (b) => crypto.createHash('sha1').update(withoutTimestamps(b)).digest('hex');
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
    await startCasting(ch);
    const chFrame = await ch.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 15000 });
    const chMedia = (await waitForText(chFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    const playing = await ch.$$eval('video', (vs) => vs.filter((v) => !v.hidden && !v.paused).length);
    assert(playing === 0, `the tab stops both of its own videos while the TV plays them (${playing} still playing)`);

    const pl1 = await readPlaylist(chMedia);
    assert(pl1.live && pl1.entries.length >= 2, `the TV gets one live playlist (${pl1.entries.length} segments, no end tag)`);
    assert((await lastStream(pl1)) === 'A', 'it plays the big stream, A');
    // Jellyfin's Live TV froze when the TV moved to a different game (Nov 2026). It reads the
    // fixed address with ffmpeg; this runs ffmpeg with the flags from Jellyfin's own log.
    const jellyfin = startJellyfinReader(relay.nowUrl);
    await jellyfin.grows(50, 20000, 'before the swap');
    await new Promise((r) => setTimeout(r, 2500)); // a live refresh, before swapping
    const pl1b = await readPlaylist(chMedia);
    assertConsistent(pl1, pl1b, 'a plain refresh');
    assert(pl1b.entries.at(-1).seq > pl1.entries.at(-1).seq, `new live segments keep arriving (${pl1.entries.at(-1).seq} -> ${pl1b.entries.at(-1).seq})`);

    const pl2 = await swapTo(chFrame, pl1b, 'B');
    ok('after Swap on TV, the playlist continues with stream B after a discontinuity');
    assertConsistent(pl1b, pl2, 'the swap to B');
    await jellyfin.grows(75, 25000, "after the swap to B, whose timestamps are an hour later than A's");
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
    // What a TV app on the fixed address has seen of this cast, before the next cast replaces it.
    const nowBefore = await readPlaylist(relay.nowUrl);
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
    await startCasting(steady);
    const steadyFrame = await steady.waitForFrame((f) => f.url().startsWith(`${RELAY}/cast/`), { timeout: 15000 });
    let steadyMedia = (await waitForText(steadyFrame, /http:\/\/[\d.]+:8789\/\S+/)).match(/http:\/\/[\d.]+:8789\/\S+/)[0];
    // Like the TV, follow a master playlist to the variant it plays.
    const firstLoad = await (await tvGet(steadyMedia)).text();
    if (firstLoad.includes('#EXT-X-STREAM-INF')) steadyMedia = new URL(firstUri(firstLoad), steadyMedia).href;
    let tvPl = await readPlaylist(steadyMedia);
    assert(tvPl.live && tvPl.entries.length >= 2, `the TV gets a live playlist (${tvPl.entries.length} segments)`);

    // Jellyfin's Live TV froze on every new cast (Nov 2026): the fixed address restarted its
    // segment numbers, and ffmpeg ignores segments numbered below ones it has seen.
    const castPrefix = new URL(steadyMedia).pathname.split('/').slice(0, 3).join('/') + '/';
    let nowNext;
    for (const deadline = Date.now() + 15000; ; ) {
      nowNext = await readPlaylist(relay.nowUrl).catch(() => null);
      if (nowNext?.entries.some((e) => new URL(e.uri).pathname.startsWith(castPrefix))) break;
      if (Date.now() > deadline) throw new Error(`${relay.nowUrl} never moved to the new cast (${castPrefix}):\n${nowNext?.text}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    assertConsistent(nowBefore, nowNext, `${relay.nowUrl} across a new cast`);
    const firstNew = nowNext.entries.find((e) => new URL(e.uri).pathname.startsWith(castPrefix));
    const lastOld = Math.max(...nowBefore.entries.map((e) => e.discNo));
    assert(
      firstNew.seq > nowBefore.entries.at(-1).seq && firstNew.discNo > lastOld,
      `the new cast's segments come after the old ones (number ${nowBefore.entries.at(-1).seq} -> ${firstNew.seq}), after a discontinuity (${lastOld} -> ${firstNew.discNo})`
    );
    // The numbering must stay consistent as live goes on, including once that discontinuity
    // scrolls off the top of the playlist.
    let nowLater = nowNext;
    for (const deadline = Date.now() + 20000; nowLater.seq <= firstNew.seq; ) {
      if (Date.now() > deadline) throw new Error(`the new cast's first segment never scrolled off ${relay.nowUrl}:\n${nowLater.text}`);
      await new Promise((r) => setTimeout(r, 1000));
      const next = await readPlaylist(relay.nowUrl);
      assertConsistent(nowLater, next, `${relay.nowUrl} as live goes on`, { quiet: true });
      nowLater = next;
    }
    assertConsistent(nowNext, nowLater, `${relay.nowUrl} after the new cast's first segment scrolls off`);
    // The same ffmpeg reader, still open from the Swap on TV cast, as Jellyfin's would be.
    await jellyfin.grows(75, 25000, 'after a new cast replaces the one it started on');
    jellyfin.stop();
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
    // With the Jellyfin-style reader above having read this cast, this pause reached the TV every
    // time (3 of 3 runs, Nov 2026) while the relay read the source only when a TV asked; reading
    // it on a timer (keepRefreshing) fixed it. How the reader drained the reserve isn't pinned
    // down: an idle TV alone doesn't (tried: 14 s without a request, reserve intact).
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
    // The Swap on TV cast before this one was replaced over 40 s ago, with video still held back
    // for its TV. The relay drops that work instead of waiting on a player tab that has moved on.
    assert(relay.replaced.size > 0, `the relay replaced earlier casts (${relay.replaced.size})`);
    assert(
      relay.errorsAfterReplaced.length === 0,
      `the relay printed no errors about a cast after replacing it (${JSON.stringify(relay.errorsAfterReplaced)})`
    );
    await steady.close();

    step('Manual mode: paste URL + Referer into the player page');
    const manual = await browser.newPage();
    await manual.goto(`chrome-extension://${ext.id}/player.html`);
    await manual.type('input[name=url]', MASTER_URL);
    await manual.type('input[name=referer]', EMBED + '/');
    await manual.click('button::-p-text(Play)');
    const manualTime = await waitForPlayback(manual, 'manual player');
    ok(`manual mode plays (t=${manualTime.toFixed(1)}s)`);

    step('Frames missing from the stream show as a warning, and in the menu');
    // A gap in the video's timeline, as countFrames records one when frames never arrive.
    await manual.evaluate(() => (streams[0].gapFrames += 5));
    const framesMsg = await waitForText(manual, /Frames in the last 10 s: .*\d+ missing from the stream itself/, 5000);
    ok(`over the video: "${framesMsg.slice(0, 120)}"`);
    await manual.click('summary::-p-text(Details)');
    const framesTotal = await waitForText(manual, /Frames so far: \d+ skipped by Chrome's video player, \d+ missing from the stream/, 5000);
    ok(`in the menu's details: "${framesTotal}"`);
    const framesShowing = () => manual.$eval('#problems', (e) => /Frames in the last 10 s/.test(e.textContent));
    await manual.click('#frame-warnings'); // the menu's switch: off
    await manual.waitForFunction(() => !/Frames in the last 10 s/.test(document.getElementById('problems').textContent), { timeout: 3000 });
    ok('the menu switch turns the warning off');
    await manual.click('#frame-warnings'); // and back on
    await manual.waitForFunction(() => /Frames in the last 10 s/.test(document.getElementById('problems').textContent), { timeout: 3000 });
    assert(await framesShowing(), 'and on again');

    step("An older message doesn't stop the automatic retries; Retry pressed twice starts the stream once");
    await manual.evaluate(() => (streams[0].error = 'An older, unrelated message'));
    await failSegment(manual);
    await waitForText(manual, /Retrying in \d+ s \(try 1 of 3\)/, 5000);
    ok('the retry countdown starts anyway');
    const manualTab = await manual.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const oldId = await manual.evaluate(() => streams[0].id);
    // Retry over the video and Retry in the menu, at once.
    await manual.evaluate(() => {
      document.querySelector('#problems .retry').click();
      document.querySelector('#streams .retry').click();
    });
    await manual.waitForFunction((id) => streams[0].id !== id && streams[0].video.currentTime > 1, { timeout: 15000 }, oldId);
    const tabRules = await sw.evaluate(
      async (id) => (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.condition.tabIds?.includes(id)).length,
      manualTab
    );
    assert(tabRules === 1, `it plays again as one stream (header rules for the tab: ${tabRules})`);

    step('A stream with two quality levels says which one is on screen, and the menu can lock one');
    const multi = await browser.newPage();
    await multi.goto(`chrome-extension://${ext.id}/player.html`);
    await multi.type('input[name=url]', MASTER_URL.replace('/live/', '/live/multi/'));
    await multi.type('input[name=referer]', EMBED + '/');
    await multi.click('button::-p-text(Play)');
    await waitForPlayback(multi, 'two-level stream', 0.5);
    const firstHeight = await multi.evaluate(() => streams[0].hls.levels[streams[0].firstLevel]?.height);
    assert(firstHeight === 720, `it starts on the best quality (first segment: ${firstHeight}p)`);
    const autoNote = await waitForText(multi, /(240|720)p, picked automatically from 2 quality levels/);
    ok(`status names the quality on screen: "${autoNote.slice(0, 160)}"`);
    await multi.click('::-p-aria(Settings)'); // close the menu, to see the bar
    await multi.click('#quality');
    await multi.screenshot({ path: path.join(artifactsDir, 'player-quality-menu.png') });
    const options = await multi.$$eval('#quality-menu button', (bs) => bs.map((b) => b.textContent));
    assert(
      options.length === 3 && /^Auto/.test(options[0]) && /^720p/.test(options[1]) && /^240p/.test(options[2]),
      `the bar's quality menu lists Auto, then highest first (${options.join(' | ')})`
    );
    await multi.click('#quality-menu button:nth-child(3)');
    await multi.click('::-p-aria(Settings)'); // the menu's status says who picked it
    await waitForText(multi, /240p, picked by you \(of 2 quality levels\)/, 15000);
    ok('picking 240p switches to it and says it was picked by hand');
    await multi.click('::-p-aria(Settings)');
    await multi.click('#quality');
    await multi.click('#quality-menu button:nth-child(2)');
    await multi.click('::-p-aria(Settings)');
    await waitForText(multi, /720p, picked by you \(of 2 quality levels\)/, 15000);
    await multi.click('::-p-aria(Settings)');
    await multi.waitForFunction(() => /^720p/.test(document.getElementById('resolution').textContent), { timeout: 5000 });
    ok('the bar shows 720p');
    const lockedT = await multi.evaluate(() => document.querySelector('video').currentTime);
    await waitForPlayback(multi, 'two-level stream after switching up', lockedT + 1, 10000);
    ok('picking 720p switches up, and playback goes on');
    const beforeDrop = await multi.evaluate(() => streams[0].id);
    await failSegment(multi);
    await multi.waitForFunction((id) => streams[0].id !== id && streams[0].video.currentTime > 1, { timeout: 20000 }, beforeDrop);
    const kept = await multi.evaluate(() => ({ height: streams[0].hls.levels[streams[0].quality]?.height, auto: streams[0].hls.autoLevelEnabled }));
    assert(kept.height === 720 && !kept.auto, `after a drop and a retry, it stays on the 720p picked by hand (${JSON.stringify(kept)})`);
    await multi.close();

    step('A stream with uneven frame timestamps is called out; the menu says how it is decoded');
    const jitter = await browser.newPage();
    await jitter.goto(`chrome-extension://${ext.id}/player.html`);
    await jitter.type('input[name=url]', MASTER_URL.replace('/live/master.m3u8', '/live/jitter/index.m3u8'));
    await jitter.type('input[name=referer]', EMBED + '/');
    await jitter.click('button::-p-text(Play)');
    await jitter.click('summary::-p-text(Details)');
    const unevenNote = await waitForText(jitter, /Frame timing uneven: \d+% of frames off their beat/, 15000);
    ok(`menu's details: "${unevenNote}"`);
    const decodingNote = await waitForText(jitter, /H\.264, (hardware decoding available|no hardware decoding)/, 5000);
    ok(`and how it's decoded: "${decodingNote}"`);
    // The test video's even copy isn't called out.
    assert(!(await manual.$eval('#streams', (e) => /frame timing uneven/i.test(e.textContent))), 'an even stream is not called out');
    await jitter.close();

    step('A playlist linked directly (no list of qualities) still shows the real resolution');
    const direct = await browser.newPage();
    await direct.goto(`chrome-extension://${ext.id}/player.html`);
    await direct.type('input[name=url]', MASTER_URL.replace('master.m3u8', 'index.m3u8'));
    await direct.type('input[name=referer]', EMBED + '/');
    await direct.click('button::-p-text(Play)');
    await waitForPlayback(direct, 'directly linked playlist', 0.5);
    const directNote = await waitForText(direct, /240p, the only quality level/);
    ok(`status reads the size off the video: "${directNote.slice(0, 160)}"`);
    await direct.close();

    step('A playlist the server garbles shows why it stopped and what the server sent, and is retried');
    const garbled = await browser.newPage();
    await garbled.goto(`chrome-extension://${ext.id}/player.html`);
    await garbled.type('input[name=url]', MASTER_URL.replace('/live/', '/live/broken/'));
    await garbled.type('input[name=referer]', EMBED + '/');
    await garbled.click('button::-p-text(Play)');
    // A garbled reply is retried like a failed load, so this takes a few seconds.
    const garbledShort = await waitForText(garbled, /isn't a playlist\. Retrying in \d+ s \(try 1 of 3\)/, 30000);
    assert(
      !/EXTM3U|Buffering|Reconnecting/.test(garbledShort),
      `over the video, one short line says it stopped and when it retries, without the technical detail ("${garbledShort}")`
    );
    await garbled.click('summary::-p-text(Details)');
    const garbledMsg = await waitForText(garbled, /isn't a playlist\. Retrying in \d+ s \(try 1 of 3\).*EXTM3U.*503 Service Unavailable/);
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

    step('A decoding error is recovered in place; a second one soon after restarts the stream');
    // The error hls.js reports when the browser's decoder rejects video (a corrupt segment).
    const decodeError = () =>
      rot.evaluate(() => {
        streams[0].hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_APPEND_ERROR, fatal: true });
        return { id: streams[0].id, t: streams[0].video.currentTime };
      });
    const problemsShow = (page, re) =>
      page.waitForFunction((src) => new RegExp(src).test(document.getElementById('problems').textContent), { timeout: 15000, polling: 'mutation' }, re.source);
    const beforeDecode = await decodeError();
    await problemsShow(rot, /decoder hit a problem.*recovering/);
    ok('it says the decoder hit a problem and is recovering');
    // Live: the playlist holds only a few seconds, so playing on needs new segments loaded.
    await waitForPlayback(rot, 'live stream after decoder recovery', beforeDecode.t + 6, 20000);
    assert((await rot.evaluate(() => streams[0].id)) === beforeDecode.id, 'and plays on, loading new segments, without reloading the stream');
    await decodeError();
    await problemsShow(rot, /couldn't be decoded.*Retrying in \d+ s \(try 1 of 3\)/);
    ok('a second one within 30 s stops it, and the automatic retry takes over');
    await rot.close();

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

    // Live streams just play: a pause, from a media key or the browser, is undone and noted.
    await flaky.evaluate(() => document.querySelector('video').pause());
    const pausedT = await flaky.evaluate(() => document.querySelector('video').currentTime);
    await waitForPlayback(flaky, 'flaky live stream after a pause', pausedT + 1, 5000);
    await flaky.click('::-p-aria(Settings)');
    await flaky.click('summary::-p-text(Details)');
    const resumeNote = await waitForText(flaky, /resumed after 1 pause/i);
    ok(`a pause is undone at once and noted in the status: "${resumeNote.slice(0, 160)}"`);
    await flaky.close();

    step('A stream whose server stops answering is tried again by itself, and plays again');
    const down = await browser.newPage();
    const downLogs = [];
    down.on('console', (m) => /retrying in/i.test(m.text()) && downLogs.push(m.text()));
    await down.goto(`chrome-extension://${ext.id}/player.html`);
    await down.type('input[name=url]', MASTER_URL.replace('/live/', '/live/down/'));
    await down.type('input[name=referer]', EMBED + '/');
    await down.click('button::-p-text(Play)');
    const retryNote = await waitForText(down, /Retrying in 5 s \(try 1 of 3\)/, 15000);
    ok(`it says so: "${retryNote.slice(0, 160)}"`);
    await new Promise((r) => setTimeout(r, 2500)); // a few seconds of countdown
    assert(downLogs.length === 1, `the countdown logs once, not every second (${downLogs.length} log lines)`);
    await waitForPlayback(down, 'dropped stream after the automatic retry', 1, 20000);
    ok('and plays once the server answers again');
    const backNote = await waitForText(down, /Back after 1 automatic retry/, 5000);
    ok(`and says it's back: "${backNote}"`);
    await down.close();

    step('Manual mode without a Referer fails loudly, not silently');
    const bad = await browser.newPage();
    await bad.goto(`chrome-extension://${ext.id}/player.html`);
    await bad.type('input[name=url]', MASTER_URL);
    await bad.click('button::-p-text(Play)');
    await bad.waitForSelector('::-p-text(403)', { timeout: 10000 });
    ok('player shows the 403 error to the user');
    await bad.screenshot({ path: path.join(artifactsDir, 'player-403.png') });
    const expiredMsg = await waitForText(bad, /probably expired/);
    ok(`a refused link isn't retried by itself, and says why: "${expiredMsg.slice(-110)}"`);
    const refusedSoFar = servers.rejected.length;
    // Clicking a message copies it. (The test browser's clipboard is stubbed to see what was sent.)
    await bad.evaluate(() => (navigator.clipboard.writeText = async (t) => void (window.copiedText = t)));
    await bad.click('#problems p.error .text');
    await bad.waitForSelector('#problems .copied', { timeout: 3000 });
    const copied = await bad.evaluate(() => window.copiedText);
    assert(/probably expired.*403/.test(copied), `clicking the message copies it, and says so ("${copied.slice(0, 60)}…")`);
    await bad.click('#problems p.error .retry');
    for (let i = 0; i < 50 && servers.rejected.length === refusedSoFar; i++) await new Promise((r) => setTimeout(r, 200));
    assert(servers.rejected.length > refusedSoFar, 'Retry asks the server again (which refuses again: the link is bad)');
    await bad.waitForSelector('#problems p.error .dismiss', { timeout: 10000 });
    await bad.click('#problems p.error .dismiss');
    await bad.waitForFunction(() => !/403/.test(document.getElementById('problems').textContent), { timeout: 5000 });
    ok('the × on the error dismisses it');

    step('"Reopen last player" in the popup brings back the streams the player showed last');
    const lastSession = await sw.evaluate(async () => (await chrome.storage.session.get('lastSession')).lastSession);
    const lastUrls = await sw.evaluate(async (ids) => Object.values(await chrome.storage.session.get(ids.map((id) => `cap:${id}`))).map((c) => c.url), lastSession);
    await page.bringToFront();
    await ext.triggerAction(page);
    const reopenPopup = await (await browser.waitForTarget((t) => t.url().includes('/popup.html'), { timeout: 5000 })).asPage();
    const openBefore = new Set(browser.targets());
    const reopenedTarget = browser.waitForTarget((t) => !openBefore.has(t) && t.url().includes('/player.html?cap='), { timeout: 5000 });
    await reopenPopup.click('::-p-text(Reopen last player)');
    const reopened = await (await reopenedTarget).asPage();
    assert(
      JSON.stringify(new URL(reopened.url()).searchParams.getAll('cap')) === JSON.stringify(lastSession),
      `it opens a player with the last session's ${lastSession.length} stream(s)`
    );
    await reopened.waitForFunction((url) => document.getElementById('streams').textContent.includes(url), { timeout: 5000 }, lastUrls[0]);
    ok(`which loads them again (${lastUrls[0]})`);
    await reopened.close();

    step("A popup closed in the middle of a quality check leaves no header rule behind");
    await page.bringToFront();
    const targetsBefore = new Set(browser.targets()); // the last popup's target may linger
    await ext.triggerAction(page);
    const closingPopup = await (
      await browser.waitForTarget((t) => !targetsBefore.has(t) && t.url().includes('/popup.html'), { timeout: 5000 })
    ).asPage();
    await closingPopup.waitForSelector('button::-p-text(Check quality)', { timeout: 5000 });
    await closingPopup.click('button::-p-text(Check quality)');
    const popupRuleCount = () =>
      sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.condition.tabIds?.includes(chrome.tabs.TAB_ID_NONE)).length);
    // Mid-check: its preview is playing (it waits its turn behind the popup's playlist reads).
    await closingPopup.waitForSelector('.preview:not([hidden]) video', { timeout: 15000 });
    assert((await popupRuleCount()) > 0, 'the check has its header rule');
    await closingPopup.close();
    for (let i = 0; i < 30 && (await popupRuleCount()) > 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert((await popupRuleCount()) === 0, 'closing the popup removes it');

    step('The garbled playlist from earlier gives up after 3 automatic retries, and says so');
    // Its retries (5 + 15 + 30 s) have been running behind the steps since.
    const gaveUp = await waitForText(garbled, /^Stopped after 3 automatic retries: the server sent something that isn't a playlist\. Press Retry/, 60000);
    ok(`"${gaveUp.slice(0, 110)}…"`);
    assert(await garbled.$('#problems .retry'), 'with a Retry button');

    step('"Cast via relay" with headers the CDN rejects reports the 403 instead of casting a dead URL');
    await startCasting(bad);
    const badRelayMsg = await waitForText(bad, /^Relay:.*403/);
    ok(`player reports: "${badRelayMsg}"`);

  } finally {
    for (const r of readers) r.stop();
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
  console.error('\nFAIL — test did not finish within 360s (hung)');
  process.exit(1);
}, 360000);
watchdog.unref();

main().catch((err) => {
  console.error(`\nFAIL — ${err.stack || err}`);
  process.exit(1);
});
