const VLC = '/Applications/VLC.app/Contents/MacOS/VLC';
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');

// Single quotes stop the shell from touching $, &, ? etc. in tokenized URLs.
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function vlcCommand(c) {
  const parts = [VLC];
  if (c.referer) parts.push(`--http-referrer=${sq(c.referer)}`);
  if (c.userAgent) parts.push(`--http-user-agent=${sq(c.userAgent)}`);
  parts.push(sq(c.url));
  return parts.join(' ');
}

// Headers curl sets itself or that would change the response shape (compressed body).
const CURL_SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

function curlCommand(c) {
  const parts = ['curl -sS'];
  for (const [name, value] of Object.entries(c.headers || {})) {
    if (!CURL_SKIP.has(name)) parts.push(`-H ${sq(`${name}: ${value}`)}`);
  }
  parts.push(sq(c.url));
  return parts.join(' ');
}

// The full header set (cookies included) goes to the player through session storage
// rather than the URL, so it doesn't land in browser history.
async function openPlayer(c) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${id}`]: c });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?cap=${id}`) });
}

// Adds the stream to the player tab used last, as its small picture (or as its only one if
// it has none). With no player tab open, opens one.
async function addToPlayer(c) {
  const playerUrl = chrome.runtime.getURL('player.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const tabIds = contexts.filter((x) => x.documentUrl.startsWith(playerUrl)).map((x) => x.tabId);
  if (!tabIds.length) return openPlayer(c);
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  if (tabs.some((t) => t.lastAccessed == null)) throw new Error("this Chrome doesn't say which player tab was used last");
  const target = tabs.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${id}`]: c });
  const res = await chrome.runtime.sendMessage({ type: 'add-stream', tabId: target.id, capId: id });
  if (!res?.ok) throw new Error(res?.error ?? 'the player tab did not answer');
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
}

function button(label, onClick, className = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

// "host · last/two" is enough to tell a page's playlists apart; the full URL is under ⋯.
function shortName(url) {
  const u = new URL(url);
  return `${u.host} · ${u.pathname.split('/').filter(Boolean).slice(-2).join('/')}`;
}

function showError(what, err) {
  console.error(`[stream-sniffer] ${what} failed`, err);
  statusEl.textContent = `Error ${what}: ${err.message}`;
  statusEl.className = 'error';
}

async function copy(btn, text) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch (err) {
    console.error('[stream-sniffer] clipboard write failed', err);
    btn.textContent = `Copy failed: ${err.message}`;
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

// Streams are only ever appended (a refreshed URL keeps its slot), so new ones are added to the
// end and existing entries are left alone; rebuilding them would swap buttons out from under a
// click. Buttons read the latest capture for their slot when clicked.
let current = [];

function render(captures) {
  current = captures;
  if (captures.length < listEl.children.length) listEl.replaceChildren(); // tab navigated: list reset
  if (!captures.length) {
    statusEl.textContent = 'No .m3u8 streams seen on this tab yet. Start playback on the page; this list updates live.';
    return;
  }
  if (statusEl.className !== 'error') statusEl.textContent = '';
  for (let i = listEl.children.length; i < captures.length; i++) listEl.append(streamItem(i));
}

// Each stream: its short name and the two buttons used nearly every time. ⋯ shows the full URL,
// the headers, and the copy buttons.
function streamItem(i) {
  const c = current[i];
  const latest = () => current[i];
  const li = document.createElement('li');

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = shortName(c.url);
  name.title = c.url;

  const more = document.createElement('div');
  more.className = 'more';
  more.hidden = true;
  const url = document.createElement('code');
  url.textContent = c.url;
  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = c.referer ? `Referer: ${c.referer}` : 'No Referer was sent';
  if (c.origin) meta.textContent += ` · Origin: ${c.origin}`;
  if (c.viaServiceWorker) meta.textContent += " · fetched by the page's service worker";
  const copies = document.createElement('div');
  copies.className = 'actions';
  copies.append(
    button('Copy URL', (e) => copy(e.currentTarget, latest().url)),
    button('Copy VLC command', (e) => copy(e.currentTarget, vlcCommand(latest()))),
    button('Copy curl command', (e) => copy(e.currentTarget, curlCommand(latest())))
  );
  more.append(url, meta, copies);

  const moreBtn = button('⋯', () => {
    more.hidden = !more.hidden;
    moreBtn.setAttribute('aria-expanded', String(!more.hidden));
  }, 'icon');
  moreBtn.setAttribute('aria-label', 'More');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.title = 'Full URL, headers, and copy buttons';

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Add to player', () => addToPlayer(latest()).catch((err) => showError('adding to player', err)), 'primary'),
    button('Open in player', () => openPlayer(latest()).catch((err) => showError('opening player', err))),
    moreBtn
  );

  li.append(name, actions, more);
  return li;
}

async function main() {
  document.getElementById('manual').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('player.html') })
  );
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Could not find the active tab');
  const k = `tab:${tab.id}`;
  const { [k]: captures = [] } = await chrome.storage.session.get(k);
  render(captures);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[k]) render(changes[k].newValue || []);
  });
}

main().catch((err) => {
  console.error('[stream-sniffer] popup failed', err);
  statusEl.textContent = `Error: ${err.message}`;
  statusEl.className = 'error';
});
