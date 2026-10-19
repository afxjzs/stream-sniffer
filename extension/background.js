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
  serialRules(() => removeTabStreams(tabId)).catch((err) =>
    console.error('[stream-sniffer] failed to remove header rules for closed tab', tabId, err)
  );
});

// The player page can't set Referer/Origin itself (browsers forbid it), so it asks us to
// rewrite them. A player tab can play several streams that need different headers, so each
// stream gets its own rule, limited to its tab and to the hosts that stream has used. The
// player registers each host before its first request there ('stream-host').
//   stream-headers {streamId, referer, origin}  set a stream's headers (replaces earlier ones)
//   stream-host    {streamId, url}              let that stream's headers apply to url's host
//   stream-remove  {streamId}                   drop the stream's rule
//   player-reset   {}                           drop every stream rule of the tab (page load)
const STREAM_MESSAGES = {
  'stream-headers': setStreamHeaders,
  'stream-host': addStreamHost,
  'stream-remove': removeStream,
  'player-reset': (tabId) => removeTabStreams(tabId).then(() => ({})),
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = STREAM_MESSAGES[msg?.type];
  if (!handler) return false;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ error: `${msg.type} must come from a tab` });
    return false;
  }
  serialRules(() => handler(tabId, msg))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async response
});

// Rule changes are read-modify-write on storage and the rule list; run them one at a time.
let rulesQueue = Promise.resolve();
function serialRules(fn) {
  const p = rulesQueue.then(fn);
  rulesQueue = p.catch(() => {}); // the caller gets p's error; this only keeps the queue going
  return p;
}

// streams:<tabId> = { [streamId]: { ruleId, referer, origin, hosts: [] } }
const streamsKey = (tabId) => `streams:${tabId}`;
async function tabStreams(tabId) {
  const k = streamsKey(tabId);
  return (await chrome.storage.session.get(k))[k] || {};
}

async function setStreamHeaders(tabId, { streamId, referer, origin }) {
  const streams = await tabStreams(tabId);
  const old = streams[streamId];
  if (old) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [old.ruleId] });
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ruleId = Math.max(0, ...rules.map((r) => r.id)) + 1;
  streams[streamId] = { ruleId, referer: referer || '', origin: origin || '', hosts: [] };
  await chrome.storage.session.set({ [streamsKey(tabId)]: streams });
  const names = [referer && 'referer', origin && 'origin'].filter(Boolean);
  return { mode: names.length ? `rewriting ${names.join(' + ')}` : 'no header rewrite (no Referer/Origin given)' };
}

async function addStreamHost(tabId, { streamId, url }) {
  const streams = await tabStreams(tabId);
  const s = streams[streamId];
  if (!s) throw new Error(`unknown stream ${streamId} (its headers were never set, or the tab was reset)`);
  const host = new URL(url).hostname;
  if (s.hosts.includes(host)) return {};
  // Rules can only tell streams apart by host. Two streams that need different headers from the
  // same host would each get the other's headers some of the time, so refuse instead.
  const clash = Object.entries(streams).find(
    ([id, o]) => id !== streamId && o.hosts.includes(host) && (o.referer !== s.referer || o.origin !== s.origin)
  );
  if (clash) {
    throw new Error(`${host} is already used by the other stream in this tab with a different Referer/Origin; one tab can't send both`);
  }
  s.hosts.push(host);
  await chrome.storage.session.set({ [streamsKey(tabId)]: streams });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [s.ruleId],
    addRules: [streamRule(tabId, s)],
  });
  return {};
}

function streamRule(tabId, s) {
  const requestHeaders = [];
  if (s.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: s.referer });
  if (s.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: s.origin });
  return {
    id: s.ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      ...(requestHeaders.length && { requestHeaders }),
      // Extension pages with host access already skip CORS; this covers CDNs that send
      // an ACAO for the embed origin only, should Chrome ever enforce it here.
      responseHeaders: [{ header: 'access-control-allow-origin', operation: 'set', value: '*' }],
    },
    condition: { tabIds: [tabId], requestDomains: s.hosts, resourceTypes: ['xmlhttprequest', 'media', 'other'] },
  };
}

async function removeStream(tabId, { streamId }) {
  const streams = await tabStreams(tabId);
  const s = streams[streamId];
  if (!s) return {};
  delete streams[streamId];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [s.ruleId] });
  await chrome.storage.session.set({ [streamsKey(tabId)]: streams });
  return {};
}

async function removeTabStreams(tabId) {
  const streams = await tabStreams(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: Object.values(streams).map((s) => s.ruleId) });
  await chrome.storage.session.remove(streamsKey(tabId));
}
