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

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
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

function render(captures) {
  listEl.replaceChildren();
  if (!captures.length) {
    statusEl.textContent = 'No .m3u8 streams seen on this tab yet. Start playback on the page; this list updates live.';
    return;
  }
  statusEl.textContent = `${captures.length} stream${captures.length > 1 ? 's' : ''} seen. The first is usually the master playlist.`;
  for (const c of captures) {
    const li = document.createElement('li');

    const url = document.createElement('code');
    url.className = 'url';
    url.textContent = c.url;

    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = c.referer ? `Referer: ${c.referer}` : 'No Referer was sent';
    if (c.origin) meta.textContent += ` · Origin: ${c.origin}`;

    const cmd = vlcCommand(c);
    const cmdEl = document.createElement('code');
    cmdEl.className = 'cmd';
    cmdEl.textContent = cmd;

    const curl = curlCommand(c);
    const curlEl = document.createElement('code');
    curlEl.className = 'cmd';
    curlEl.textContent = curl;

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('Open in player', () =>
        openPlayer(c).catch((err) => {
          console.error('[stream-sniffer] open player failed', err);
          statusEl.textContent = `Error opening player: ${err.message}`;
          statusEl.className = 'error';
        })
      ),
      button('Copy VLC command', (e) => copy(e.currentTarget, cmd)),
      button('Copy curl', (e) => copy(e.currentTarget, curl)),
      button('Copy URL', (e) => copy(e.currentTarget, c.url))
    );

    li.append(url, meta, actions, cmdEl, curlEl);
    listEl.append(li);
  }
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
