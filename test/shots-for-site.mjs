// One-off: capture crisp screenshots of the extension (against the fake test site) and a
// 1200x630 card image for the doug.is project page. Not part of the test suite.
//   node shots-for-site.mjs <output dir>
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers, SITE, EMBED } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const out = process.argv[2];
if (!out) throw new Error('usage: node shots-for-site.mjs <output dir>');
fs.mkdirSync(out, { recursive: true });

const servers = await startServers({
  streamDir: path.join(here, 'fixtures/stream'),
  hlsJsPath: path.join(extDir, 'vendor/hls.min.js'),
});
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [extDir],
  defaultViewport: { width: 1100, height: 640, deviceScaleFactor: 2 },
});
try {
  await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const ext = [...(await browser.extensions()).values()].find((e) => e.path === extDir);

  const page = await browser.newPage();
  await page.goto(SITE + '/');
  const embed = await page.waitForFrame((f) => f.url().startsWith(EMBED));
  await embed.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1.5, { timeout: 20000 });

  // A real popup can't be captured reliably beyond its visible area (screenshots tile), so
  // render popup.html in a normal tab and give that tab the site tab's captured streams.
  const shotPage = await browser.newPage();
  await shotPage.setViewport({ width: 504, height: 470, deviceScaleFactor: 2 });
  await shotPage.goto(`chrome-extension://${ext.id}/popup.html`);
  await shotPage.bringToFront();
  const seeded = await shotPage.evaluate(async (siteUrl) => {
    const tabs = await chrome.tabs.query({});
    const site = tabs.find((t) => t.url?.startsWith(siteUrl));
    if (!site) throw new Error(`site tab not found: ${JSON.stringify(tabs.map((t) => t.url))}`);
    const { [`tab:${site.id}`]: captures } = await chrome.storage.session.get(`tab:${site.id}`);
    if (!captures?.length) throw new Error('no captures on the site tab');
    // The same lookup popup.js does, so the seeded slot is the one it reads.
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.storage.session.set({ [`tab:${active.id}`]: captures });
    return { active: active.url, count: captures.length };
  }, SITE);
  console.log('seeded', seeded);
  // popup.js re-renders when its storage slot changes, so no reload is needed.
  await shotPage.waitForSelector('li', { timeout: 5000 }).catch(async (err) => {
    throw new Error(`stand-in popup rendered no streams; page says: ${await shotPage.evaluate(() => document.body.innerText)} (${err.message})`);
  });
  await shotPage.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });


  const playerP = browser.waitForTarget((t) => t.url().includes('/player.html'));
  const firstItem = await shotPage.$('li');
  await (await firstItem.$('button::-p-text(Open in player)')).click();
  const player = await (await playerP).asPage();
  await player.setViewport({ width: 1100, height: 640, deviceScaleFactor: 2 });
  await player.bringToFront();
  await player.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 2, { timeout: 20000 });
  await player.screenshot({ path: path.join(out, 'player.png') });

  // Card: title, one line, and the popup screenshot, on the site's dark background.
  const popupData = fs.readFileSync(path.join(out, 'popup.png')).toString('base64');
  const card = await browser.newPage();
  await card.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><body style="margin:0;width:1200px;height:630px;background:#0b0d12;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;align-items:center;gap:56px;padding:0 64px;box-sizing:border-box">
    <div style="flex:1">
      <div style="font:600 18px ui-monospace,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase;color:#d4a853">Chrome extension</div>
      <div style="font-size:72px;font-weight:700;margin:12px 0 20px">Stream Sniffer</div>
      <div style="font-size:28px;line-height:1.35;color:#aab0bb">Find the video stream a page is playing. Watch it on its own, in VLC, or on a Chromecast.</div>
    </div>
    <img src="data:image/png;base64,${popupData}" style="width:480px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);border:1px solid #2d313a">
  </body></html>`);
  await card.screenshot({ path: path.join(out, 'card.png') });
  console.log(`wrote popup.png, player.png, card.png to ${out}`);
} finally {
  await browser.close();
  await servers.close();
}
