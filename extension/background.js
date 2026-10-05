// Watches every request for .m3u8 playlists and records them per tab, along with the
// Referer/Origin/User-Agent the page sent. Those headers are what the CDN usually checks,
// so they're what you need to replay the stream anywhere else.

const M3U8 = /\.m3u8(\?|#|$)/i;
const key = (tabId) => `tab:${tabId}`;
// Origins of every frame loaded in a tab, to credit service-worker requests to the right tab.
const framesKey = (tabId) => `frames:${tabId}`;

// Players often add a cache-buster (?_=1791240957421) on every refresh. Ignore such params when
// deciding whether two URLs are the same stream: params named like cache-busters, or whose
// value is a bare 10-13 digit timestamp.
const CACHE_BUSTER_NAMES = new Set(['_', 'cb', 'nocache', 'rnd', 'rand', 'ts', 'timestamp']);
function streamKey(url) {
  const u = new URL(url);
  for (const [name, value] of [...u.searchParams]) {
    if (CACHE_BUSTER_NAMES.has(name.toLowerCase()) || /^\d{10,13}$/.test(value)) u.searchParams.delete(name);
  }
  u.hash = '';
  return u.href;
}

// Storage writes are read-modify-write; chain them so concurrent requests don't drop entries.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error('[stream-sniffer] storage update failed:', err));
  return queue;
}

// The page the stream came from, so the player can show it. Title can be blank while the page
// is still loading; the player falls back to the URL.
async function pageOf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { pageUrl: tab.url || '', pageTitle: tab.title || '' };
  } catch (err) {
    console.warn('[stream-sniffer] could not read the source tab', tabId, err);
    return { pageUrl: '', pageTitle: '' };
  }
}

async function addCapture(tabId, capture) {
  capture = { ...capture, ...(await pageOf(tabId)) };
  const k = key(tabId);
  const { [k]: list = [] } = await chrome.storage.session.get(k);
  const i = list.findIndex((c) => streamKey(c.url) === streamKey(capture.url));
  if (i >= 0) {
    // A live player re-requests its playlist every few seconds; nothing to save unless the URL
    // changed (a fresh cache-buster). Then keep the newest URL and headers in the same slot.
    if (list[i].url === capture.url) return;
    list[i] = { ...capture, time: list[i].time };
    await chrome.storage.session.set({ [k]: list });
    return;
  }
  list.push(capture);
  await chrome.storage.session.set({ [k]: list });
  await chrome.action.setBadgeText({ tabId, text: String(list.length) });
}

async function clearTab(tabId, topOrigin) {
  await chrome.storage.session.remove(key(tabId));
  await chrome.storage.session.set({ [framesKey(tabId)]: [topOrigin] });
  await chrome.action.setBadgeText({ tabId, text: '' });
}

async function addFrameOrigin(tabId, origin) {
  const k = framesKey(tabId);
  const { [k]: origins = [] } = await chrome.storage.session.get(k);
  if (origins.includes(origin)) return;
  origins.push(origin);
  await chrome.storage.session.set({ [k]: origins });
}

// Requests from a service worker have no tab (tabId -1). Credit them to every tab that has a
// frame from the worker's origin; with none, say so instead of dropping it silently.
async function tabsForOrigin(origin) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k, origins]) => k.startsWith('frames:') && origins.includes(origin))
    .map(([k]) => Number(k.slice('frames:'.length)));
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!M3U8.test(details.url)) return;
    // Our own player's requests also hit .m3u8 URLs; don't record those.
    if (details.initiator?.startsWith('chrome-extension://')) return;
    const h = Object.fromEntries((details.requestHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
    const capture = {
      url: details.url,
      referer: h.referer || '',
      origin: h.origin || '',
      userAgent: h['user-agent'] || '',
      headers: h, // everything the browser sent, for the curl command and the relay
      time: Date.now(),
    };
    if (details.tabId >= 0) {
      enqueue(() => addCapture(details.tabId, capture));
      return;
    }
    enqueue(async () => {
      const tabs = details.initiator ? await tabsForOrigin(details.initiator) : [];
      if (!tabs.length) {
        console.warn('[stream-sniffer] playlist fetched outside any tab, with no matching frame; not listed:', details.url, 'initiator:', details.initiator);
        return;
      }
      for (const tabId of tabs) await addCapture(tabId, { ...capture, viaServiceWorker: true });
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'] // extraHeaders is required to see Referer and Origin
);

// A new top-level page load in the tab starts a fresh list; every frame load records its origin.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const origin = new URL(details.url).origin;
    if (details.type === 'main_frame') enqueue(() => clearTab(details.tabId, origin));
    else enqueue(() => addFrameOrigin(details.tabId, origin));
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => chrome.storage.session.remove([key(tabId), framesKey(tabId)]));
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [tabId] })
    .catch((err) => console.error('[stream-sniffer] failed to remove header rule for closed tab', tabId, err));
});

// The player page can't set Referer/Origin itself (browsers forbid it), so it asks us to
// install a header-rewrite rule scoped to its own tab before it starts loading.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'prepare-player') return false;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ error: 'prepare-player must come from a tab' });
    return false;
  }
  preparePlayer(tabId, msg)
    .then((mode) => sendResponse({ ok: true, mode }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async response
});

async function preparePlayer(tabId, { referer, origin }) {
  const requestHeaders = [];
  if (referer) requestHeaders.push({ header: 'referer', operation: 'set', value: referer });
  if (origin) requestHeaders.push({ header: 'origin', operation: 'set', value: origin });

  if (requestHeaders.length === 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
    return 'no header rewrite (no Referer/Origin given)';
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
          // Extension pages with host access already skip CORS; this covers CDNs that send
          // an ACAO for the embed origin only, should Chrome ever enforce it here.
          responseHeaders: [{ header: 'access-control-allow-origin', operation: 'set', value: '*' }],
        },
        condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
      },
    ],
  });
  return `rewriting ${requestHeaders.map((h) => h.header).join(' + ')}`;
}
