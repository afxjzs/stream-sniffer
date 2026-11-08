// Runs inside every page (the page's own JavaScript world, before its scripts), for players whose
// playlists never cross the network: a Shaka Player page can register its own address scheme
// (vttp://… on StreamEast's "Server 1", Nov 2026) and answer playlist requests itself, so
// background.js, which watches the network for .m3u8, never sees them.
//
// This wraps Shaka's NetworkingEngine.request (public API, shared by every player on the page):
// a playlist that arrives from a non-web address is reported to page-bridge.js, which hands it to
// background.js. Later, the extension's player asks for fresh copies the same way (fetch below),
// so the page has to stay open while that stream plays.
//
// It never changes what the page's player gets: the original request runs untouched, and this
// only reads its result.
(() => {
  const CHANNEL = 'stream-sniffer:page-hook';
  const reported = new Set();
  let engine = null; // the NetworkingEngine that last loaded such a playlist; fetch uses it

  const post = (msg) => window.postMessage({ channel: CHANNEL, dir: 'to-extension', ...msg }, '*');
  const isWeb = (uri) => /^https?:/i.test(uri);
  const textOf = (data) => new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);

  function wrapShaka(shaka) {
    const NE = shaka?.net?.NetworkingEngine;
    const proto = NE?.prototype;
    if (!proto?.request || proto.request.streamSniffer) return;
    const original = proto.request;
    const wrapped = function (type, request) {
      const op = original.apply(this, arguments);
      try {
        const uri = request?.uris?.[0];
        if (typeof uri === 'string' && !isWeb(uri) && op?.promise) {
          engine = this;
          op.promise.then(
            (res) => {
              if (reported.has(uri)) return;
              const text = textOf(res.data);
              if (!text.trimStart().startsWith('#EXTM3U')) return;
              reported.add(uri);
              post({ kind: 'found', uri });
            },
            // The page's own request failed; its player deals with that. Nothing to report.
            () => {}
          );
        }
      } catch (err) {
        console.warn('[stream-sniffer] page hook could not read a Shaka request:', err);
      }
      return op;
    };
    wrapped.streamSniffer = true;
    proto.request = wrapped;
    // Kept for fetch: how the page builds a request.
    wrapShaka.NE = NE;
  }

  // The extension's player asks for a playlist by its address; the page's own player machinery
  // answers it, as it would for its own player.
  async function fetchPlaylist(uri) {
    const NE = wrapShaka.NE;
    if (!NE || !engine) throw new Error("the page's player hasn't loaded a playlist this way (yet)");
    const retry = NE.defaultRetryParameters?.() ?? { maxAttempts: 2, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 10000, stallTimeout: 0, connectionTimeout: 10000 };
    const res = await engine.request(NE.RequestType.MANIFEST, NE.makeRequest([uri], retry)).promise;
    return textOf(res.data);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || m?.channel !== CHANNEL || m.dir !== 'to-page' || m.kind !== 'fetch') return;
    fetchPlaylist(m.uri).then(
      (text) => post({ kind: 'fetched', id: m.id, text }),
      (err) => post({ kind: 'fetched', id: m.id, error: String(err?.message || err?.code || err) })
    );
  });

  // --- A copy of the video itself, for players whose playlists can't be seen at all ---
  // Whatever a page's player does to get its video (a hidden playlist, a delivery library, a
  // worker), it ends up handing the browser media data through Media Source Extensions:
  // SourceBuffer.appendBuffer. This keeps, for the page's current MediaSource, each buffer's
  // type, its last init segment and its last few media chunks, and forwards new ones to the
  // extension's player while it's copying (see mirror.js). A frame follows its newest
  // MediaSource, so a page player that restarts carries the copy along.
  const RECENT_CHUNKS = 12; // media chunks kept per buffer, so a copy starts from a few seconds back
  let current = null; // { id, buffers: [{ mime, init, recent, offset }] } for the newest MediaSource
  const bufferOf = new WeakMap(); // SourceBuffer -> { source, index }
  const copies = new Set(); // ids of copies in progress, from the bridge
  let reportedVideo = false;

  const bytesOf = (data) =>
    data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  // An init segment: MP4 (ftyp/moov first) or WebM (the EBML header).
  const isInit = (b) => {
    if (b.length >= 8) {
      const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
      if (box === 'ftyp' || box === 'moov') return true;
    }
    return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  };
  const toCopies = (msg) => {
    for (const copyId of copies) post({ ...msg, kind: 'copy-data', copyId });
  };
  // Everything a copy needs to start: each buffer's type and offset, its init, its recent chunks.
  const snapshot = () =>
    current && {
      source: current.id,
      buffers: current.buffers.map((b) => ({ mime: b.mime, offset: b.offset })),
      chunks: current.buffers.flatMap((b, index) => [b.init, ...b.recent].filter(Boolean).map((data) => ({ index, data }))),
    };

  try {
    const MS = window.MediaSource;
    const SB = window.SourceBuffer;
    if (MS && SB) {
      const addSourceBuffer = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mime) {
        const sb = addSourceBuffer.apply(this, arguments);
        try {
          if (!this.streamSnifferId) {
            this.streamSnifferId = crypto.randomUUID();
            this.streamSnifferBuffers = [];
          }
          const entry = { mime, init: null, recent: [], offset: 0 };
          this.streamSnifferBuffers.push(entry);
          bufferOf.set(sb, { source: this, index: this.streamSnifferBuffers.length - 1 });
        } catch (err) {
          console.warn('[stream-sniffer] page hook could not note a SourceBuffer:', err);
        }
        return sb;
      };

      const appendBuffer = SB.prototype.appendBuffer;
      SB.prototype.appendBuffer = function (data) {
        try {
          const at = bufferOf.get(this);
          if (at) {
            const { source, index } = at;
            const entry = source.streamSnifferBuffers[index];
            const bytes = bytesOf(data);
            if (!current || current.id !== source.streamSnifferId) {
              // A newer MediaSource took over (the page's player started or restarted).
              const wasCopying = current && copies.size;
              current = { id: source.streamSnifferId, buffers: source.streamSnifferBuffers };
              if (wasCopying) toCopies({ restart: snapshot() });
            }
            if (isInit(bytes)) {
              entry.init = bytes;
              entry.recent = [];
            } else {
              entry.recent.push(bytes);
              if (entry.recent.length > RECENT_CHUNKS) entry.recent.shift();
            }
            if (copies.size) toCopies({ chunk: { index, data: bytes } });
            if (!reportedVideo && /^video\//i.test(entry.mime) && !isInit(bytes)) {
              reportedVideo = true;
              post({ kind: 'video-found', mime: entry.mime });
            }
          }
        } catch (err) {
          console.warn('[stream-sniffer] page hook could not copy appended media:', err);
        }
        return appendBuffer.apply(this, arguments);
      };

      const offset = Object.getOwnPropertyDescriptor(SB.prototype, 'timestampOffset');
      if (offset?.set) {
        Object.defineProperty(SB.prototype, 'timestampOffset', {
          ...offset,
          set(v) {
            offset.set.call(this, v);
            try {
              const at = bufferOf.get(this);
              if (at) {
                at.source.streamSnifferBuffers[at.index].offset = v;
                if (copies.size && current?.id === at.source.streamSnifferId) toCopies({ offset: { index: at.index, value: v } });
              }
            } catch (err) {
              console.warn('[stream-sniffer] page hook could not note a timestamp offset:', err);
            }
          },
        });
      }

      const changeType = SB.prototype.changeType;
      if (changeType) {
        SB.prototype.changeType = function (mime) {
          const r = changeType.apply(this, arguments);
          try {
            const at = bufferOf.get(this);
            if (at) {
              at.source.streamSnifferBuffers[at.index].mime = mime;
              if (copies.size && current?.id === at.source.streamSnifferId) toCopies({ changeType: { index: at.index, mime } });
            }
          } catch (err) {
            console.warn('[stream-sniffer] page hook could not note a type change:', err);
          }
          return r;
        };
      }
    }
  } catch (err) {
    console.warn('[stream-sniffer] page hook could not watch Media Source Extensions:', err);
  }

  // The page's video goes silent while it's copied, so the game isn't heard twice. Volume, not
  // mute: Chrome may pause a muted video that isn't on screen, which would stop the copy.
  const silencePage = () => {
    for (const v of document.querySelectorAll('video')) if (v.currentSrc.startsWith('blob:')) v.volume = 0;
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || m?.channel !== CHANNEL || m.dir !== 'to-page') return;
    if (m.kind === 'copy-start') {
      const snap = snapshot();
      if (!snap) return post({ kind: 'copy-data', copyId: m.copyId, error: "the page's player isn't playing any video yet" });
      copies.add(m.copyId);
      silencePage();
      post({ kind: 'copy-data', copyId: m.copyId, restart: snap });
    } else if (m.kind === 'copy-stop') {
      copies.delete(m.copyId);
    }
  });

  // Shaka usually arrives as a script that sets window.shaka once it's built; catch that moment,
  // before the page's next script can register its scheme or start a player.
  if (window.shaka) wrapShaka(window.shaka);
  let shakaValue = window.shaka;
  try {
    Object.defineProperty(window, 'shaka', {
      configurable: true,
      enumerable: true,
      get: () => shakaValue,
      set: (v) => {
        shakaValue = v;
        const tryWrap = () => {
          try {
            wrapShaka(shakaValue);
          } catch (err) {
            console.warn('[stream-sniffer] page hook could not wrap Shaka:', err);
          }
        };
        tryWrap();
        // A build that fills window.shaka in piece by piece is complete once its script ends;
        // microtasks run then, before the page's next script.
        queueMicrotask(tryWrap);
      },
    });
  } catch (err) {
    console.warn('[stream-sniffer] page hook could not watch for Shaka:', err);
  }
})();
