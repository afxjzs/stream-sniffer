// Watches every request for .m3u8 playlists and records them per tab, along with the
// Referer/Origin/User-Agent the page sent. Those headers are what the CDN usually checks,
// so they're what you need to replay the stream anywhere else.

const M3U8 = /\.m3u8(\?|#|$)/i;
const key = (tabId) => `tab:${tabId}`;

// Storage writes are read-modify-write; chain them so concurrent requests don't drop entries.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error('[stream-sniffer] storage update failed:', err));
  return queue;
}

async function addCapture(tabId, capture) {
  const k = key(tabId);
  const { [k]: list = [] } = await chrome.storage.session.get(k);
  if (list.some((c) => c.url === capture.url)) return;
  list.push(capture);
  await chrome.storage.session.set({ [k]: list });
  await chrome.action.setBadgeText({ tabId, text: String(list.length) });
}

async function clearTab(tabId) {
  await chrome.storage.session.remove(key(tabId));
  await chrome.action.setBadgeText({ tabId, text: '' });
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !M3U8.test(details.url)) return;
    // Our own player's requests also hit .m3u8 URLs; don't record those.
    if (details.initiator?.startsWith('chrome-extension://')) return;
    const h = Object.fromEntries((details.requestHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
    enqueue(() =>
      addCapture(details.tabId, {
        url: details.url,
        referer: h.referer || '',
        origin: h.origin || '',
        userAgent: h['user-agent'] || '',
        headers: h, // everything the browser sent, for the curl command and the relay
        time: Date.now(),
      })
    );
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'] // extraHeaders is required to see Referer and Origin
);

// A new top-level page load in the tab starts a fresh list.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) enqueue(() => clearTab(details.tabId));
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => chrome.storage.session.remove(key(tabId)));
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
