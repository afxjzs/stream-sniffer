// Plays a live copy of the video a page's player shows, for sites whose stream can't be seen any
// other way (see page-hook.js): the page's media data arrives over a port from page-bridge.js
// and goes into this player's own MediaSource, buffer for buffer, as the page appended it.
// The page has to stay open and playing.
(() => {
  const KEEP_BEHIND_S = 60; // seconds of played video kept before it's removed
  const START_BEHIND_S = 4; // start this far behind the newest copied video

  const fromBase64 = (s) => {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // video: the element to play into; viaVideo: the capture's { tabId, frameId };
  // onStart(): the copy has video to play; onFail(message): it stopped, and why.
  function start({ video, viaVideo, onStart, onFail }) {
    let stopped = false;
    let ms = null;
    let buffers = []; // [{ sb, queue }] in the page's order
    let ready = false; // the current MediaSource is open and its buffers made
    let early = []; // messages that came before it was
    let started = false;

    const stop = () => {
      stopped = true;
      clearInterval(watch);
      try {
        port.disconnect();
      } catch {
        // Already disconnected: nothing to close.
      }
    };
    const fail = (msg) => {
      if (stopped) return;
      stop();
      onFail(msg);
    };

    // Runs a buffer's queued operations one at a time, as MSE requires.
    function pump(b) {
      while (!stopped && b.queue.length && !b.sb.updating) {
        const op = b.queue[0];
        try {
          if (op.append) {
            trimBehind(b);
            if (b.sb.updating) return; // a removal started; this append runs after it
            b.queue.shift();
            b.sb.appendBuffer(op.append);
            return; // continues on updateend
          }
          b.queue.shift();
          if (op.offset != null) b.sb.timestampOffset = op.offset;
          if (op.changeType) b.sb.changeType(op.changeType);
        } catch (err) {
          return fail(`couldn't add the page's video to this player: ${err.message}`);
        }
      }
    }
    function trimBehind(b) {
      const r = b.sb.buffered;
      const cut = video.currentTime - KEEP_BEHIND_S;
      if (r.length && r.start(0) < cut) b.sb.remove(0, cut);
    }

    function queue(index, op) {
      const b = buffers[index];
      if (!b) return fail(`the page's player used a media buffer (${index + 1}) this copy doesn't have`);
      b.queue.push(op);
      pump(b);
    }

    function handle(msg) {
      if (msg.error) return fail(`couldn't copy the page's video: ${msg.error}`);
      if (msg.restart) return reset(msg.restart);
      if (!ready) return void early.push(msg);
      if (msg.chunk) queue(msg.chunk.index, { append: fromBase64(msg.chunk.data) });
      if (msg.offset) queue(msg.offset.index, { offset: msg.offset.value });
      if (msg.changeType) queue(msg.changeType.index, { changeType: msg.changeType.mime });
    }

    // A fresh MediaSource with the page's buffers: at the start, and whenever the page's
    // player restarts with a new one.
    function reset(snap) {
      ready = false;
      early = [];
      ms = new MediaSource();
      const url = URL.createObjectURL(ms);
      video.src = url;
      ms.addEventListener(
        'sourceopen',
        () => {
          URL.revokeObjectURL(url);
          if (stopped) return;
          try {
            buffers = snap.buffers.map((info) => {
              const sb = ms.addSourceBuffer(info.mime);
              const b = { sb, queue: [] };
              if (info.offset) b.queue.push({ offset: info.offset });
              sb.addEventListener('updateend', () => {
                maybeStart();
                pump(b);
              });
              sb.addEventListener('error', () => fail("the page's video couldn't be decoded here"));
              return b;
            });
          } catch (err) {
            return fail(`the page's video is in a format this player can't take (${snap.buffers.map((b) => b.mime).join(', ')}): ${err.message}`);
          }
          ready = true;
          for (const c of snap.chunks) queue(c.index, { append: fromBase64(c.data) });
          const held = early;
          early = [];
          held.forEach(handle);
        },
        { once: true }
      );
    }

    function maybeStart() {
      const r = video.buffered;
      if (started || !r.length || r.end(r.length - 1) - r.start(0) < 1) return;
      started = true;
      video.currentTime = Math.max(r.start(0), r.end(r.length - 1) - START_BEHIND_S);
      onStart();
    }

    // A gap in the copy (the page's player skipped ahead, or restarted): jump to the video after it.
    const watch = setInterval(() => {
      if (!started || video.paused || video.readyState >= 3) return;
      const r = video.buffered;
      for (let i = 0; i < r.length; i++) {
        if (r.start(i) > video.currentTime && r.start(i) - video.currentTime < 30) {
          video.currentTime = r.start(i) + 0.1;
          return;
        }
      }
    }, 1000);

    const port = chrome.tabs.connect(viaVideo.tabId, { frameId: viaVideo.frameId, name: 'video-copy' });
    port.onMessage.addListener((msg) => {
      if (!stopped) handle(msg);
    });
    port.onDisconnect.addListener(async () => {
      if (stopped) return;
      const why = chrome.runtime.lastError?.message;
      const tab = await chrome.tabs.get(viaVideo.tabId).catch(() => null);
      fail(
        tab
          ? `its page is gone or was reloaded${why ? ` (${why})` : ''}. Open the video from the popup on that page again`
          : "its page was closed. This is a copy of the video that page plays, so keep it open; reopen it and open the video from the popup again"
      );
    });
    port.postMessage({ type: 'start' });
    return { stop };
  }

  globalThis.StreamSnifferMirror = { start };
})();
