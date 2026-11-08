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

// A playlist whose address doesn't say .m3u8 is still labeled one by its server
// (application/vnd.apple.mpegurl, audio/x-mpegurl, …). Its request headers are only known
// before the answer comes, so those of every page fetch are held until it does.
const PLAYLIST_TYPE = /mpegurl/i;
const pendingHeaders = new Map(); // requestId -> request headers, until the response or an error
const PENDING_MAX = 2000; // a safety cap: a request that never ends shouldn't hold memory forever
const FETCH_TYPES = ['xmlhttprequest', 'other', 'media']; // what a player's playlist fetch can be

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // Our own player's requests also hit .m3u8 URLs; don't record those.
    if (details.initiator?.startsWith('chrome-extension://')) return;
    if (M3U8.test(details.url)) return recordPlaylist(details, details.requestHeaders);
    if (!FETCH_TYPES.includes(details.type)) return;
    if (pendingHeaders.size >= PENDING_MAX) pendingHeaders.delete(pendingHeaders.keys().next().value);
    pendingHeaders.set(details.requestId, details.requestHeaders || []);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'] // extraHeaders is required to see Referer and Origin
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const requestHeaders = pendingHeaders.get(details.requestId);
    if (!requestHeaders) return;
    pendingHeaders.delete(details.requestId);
    const type = details.responseHeaders?.find((x) => x.name.toLowerCase() === 'content-type')?.value ?? '';
    if (PLAYLIST_TYPE.test(type)) recordPlaylist(details, requestHeaders);
  },
  { urls: ['<all_urls>'], types: FETCH_TYPES },
  ['responseHeaders']
);
chrome.webRequest.onErrorOccurred.addListener((details) => pendingHeaders.delete(details.requestId), {
  urls: ['<all_urls>'],
  types: FETCH_TYPES,
});

function recordPlaylist(details, requestHeaders) {
  const h = Object.fromEntries((requestHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
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
}

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

// Playlists a page made itself, which never cross the network (see page-hook.js):
//   page-playlist {uri}                  from page-bridge.js: a page's player loaded one
//   page-fetch    {tabId, frameId, url}  from the player or popup: get a fresh copy from that page
// The Referer and Origin for the stream's segments are what a request from that frame sends by
// default across origins: its origin.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'page-playlist') {
    if (!sender.tab || sender.frameId == null) {
      console.warn('[stream-sniffer] page-playlist without a tab or frame; not listed:', msg.uri);
      return false;
    }
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : new URL(sender.url).origin;
    enqueue(() =>
      addCapture(sender.tab.id, {
        url: msg.uri,
        referer: origin + '/',
        origin,
        userAgent: navigator.userAgent,
        headers: {},
        time: Date.now(),
        viaPage: { tabId: sender.tab.id, frameId: sender.frameId },
      })
    );
    return false;
  }
  if (msg?.type === 'page-video') {
    // A frame whose player plays video through Media Source Extensions: the player can copy it
    // (see mirror.js). One entry per frame; it follows that frame's newest video.
    if (!sender.tab || sender.frameId == null) {
      console.warn('[stream-sniffer] page-video without a tab or frame; not listed');
      return false;
    }
    const host = new URL(sender.url).host || 'this page';
    enqueue(() =>
      addCapture(sender.tab.id, {
        url: `stream-sniffer-video://${host}/frame-${sender.frameId}`,
        referer: '',
        origin: '',
        userAgent: navigator.userAgent,
        headers: {},
        time: Date.now(),
        mime: msg.mime,
        viaVideo: { tabId: sender.tab.id, frameId: sender.frameId, host },
      })
    );
    return false;
  }
  if (msg?.type === 'page-fetch') {
    fetchFromPage(msg).then(
      (text) => sendResponse({ ok: true, text }),
      (err) => sendResponse({ error: err.message })
    );
    return true; // async response
  }
  return false;
});

async function fetchFromPage({ tabId, frameId, url }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("its page was closed. This stream's playlist comes from the game page, so keep that page open; reopen it and open the stream from the popup again");
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'page-fetch', uri: url }, { frameId });
  } catch (err) {
    throw new Error(`its page (${tab.title || tab.url}) is gone or was reloaded (${err.message}). Open the stream from the popup on that page again`);
  }
  if (!res?.ok) throw new Error(`its page (${tab.title || tab.url}) couldn't hand over the playlist: ${res?.error ?? 'no answer'}`);
  return res.text;
}

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
// The popup's quality check plays streams too, but the popup isn't a tab: its requests have no
// tab (TAB_ID_NONE), so its rules are also limited to requests this extension starts.
const POPUP_URL = chrome.runtime.getURL('popup.html');
// The popup holds a connection open while it's up; when it closes (even mid-check), its header
// rules go, so none outlive it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  port.onDisconnect.addListener(() => {
    serialRules(() => removeTabStreams(chrome.tabs.TAB_ID_NONE)).catch((err) =>
      console.error('[stream-sniffer] failed to remove the closed popup\'s header rules', err)
    );
  });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = STREAM_MESSAGES[msg?.type];
  if (!handler) return false;
  const tabId = sender.tab?.id ?? (sender.url?.startsWith(POPUP_URL) ? chrome.tabs.TAB_ID_NONE : null);
  if (tabId == null) {
    sendResponse({ error: `${msg.type} must come from a tab or the popup` });
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
    condition: {
      tabIds: [tabId],
      requestDomains: s.hosts,
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
      // No tab means the popup (see POPUP_URL); without this, the rule would also catch other
      // tabless requests, such as a site's service worker.
      ...(tabId === chrome.tabs.TAB_ID_NONE && { initiatorDomains: [chrome.runtime.id] }),
    },
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
