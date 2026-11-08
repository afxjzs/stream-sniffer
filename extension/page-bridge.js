// Runs in every page next to page-hook.js, in the extension's isolated world: carries messages
// between the hook (which can see the page's player but not the extension) and background.js.
(() => {
  const CHANNEL = 'stream-sniffer:page-hook';
  const FETCH_TIMEOUT_MS = 15000;
  const waiting = new Map(); // fetch id -> { resolve, reject, timer }

  // Copies of the page's video (see page-hook.js and mirror.js): one port per copy, opened by the
  // extension's player. Extension messages are JSON, so media bytes travel as base64.
  const copyPorts = new Map(); // copyId -> port
  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const encodeChunk = (c) => ({ index: c.index, data: toBase64(c.data) });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'video-copy') return;
    const copyId = crypto.randomUUID();
    copyPorts.set(copyId, port);
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'start') window.postMessage({ channel: CHANNEL, dir: 'to-page', kind: 'copy-start', copyId }, '*');
    });
    port.onDisconnect.addListener(() => {
      copyPorts.delete(copyId);
      window.postMessage({ channel: CHANNEL, dir: 'to-page', kind: 'copy-stop', copyId }, '*');
    });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || m?.channel !== CHANNEL || m.dir !== 'to-extension') return;
    if (m.kind === 'copy-data') {
      const port = copyPorts.get(m.copyId);
      if (!port) return;
      const out = { error: m.error, offset: m.offset, changeType: m.changeType };
      if (m.chunk) out.chunk = encodeChunk(m.chunk);
      if (m.restart) out.restart = { ...m.restart, chunks: m.restart.chunks.map(encodeChunk) };
      port.postMessage(out);
      return;
    }
    if (m.kind === 'video-found') {
      chrome.runtime.sendMessage({ type: 'page-video', mime: m.mime }).catch((err) =>
        console.error('[stream-sniffer] could not report the video this page plays:', err)
      );
      return;
    }
    if (m.kind === 'found') {
      chrome.runtime.sendMessage({ type: 'page-playlist', uri: m.uri }).catch((err) =>
        console.error('[stream-sniffer] could not report a playlist made by this page:', err)
      );
    } else if (m.kind === 'fetched') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error));
      else w.resolve(m.text);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'page-fetch') return false;
    const id = crypto.randomUUID();
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`the page didn't hand over the playlist within ${FETCH_TIMEOUT_MS / 1000} s`));
      }, FETCH_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, dir: 'to-page', kind: 'fetch', id, uri: msg.uri }, '*');
    }).then(
      (text) => sendResponse({ ok: true, text }),
      (err) => sendResponse({ error: err.message })
    );
    return true; // async response
  });
})();
