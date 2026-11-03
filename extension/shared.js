// Shared by the player and the popup's quality check: the hls.js loader for one stream's
// requests, and how measurements read.
(() => {
  const browserCodecs = {
    inflate: (b) => decompress(b, 'deflate'),
    gunzip: (b) => decompress(b, 'gzip'),
  };
  async function decompress(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Each stream's requests can need their own Referer/Origin. The browser only applies them to
  // hosts the stream has registered with background.js, so register each host before its first
  // request. hosts is the stream's Set of hosts registered so far.
  async function allowHost(streamId, hosts, url) {
    const host = new URL(url).hostname;
    if (hosts.has(host)) return;
    const res = await chrome.runtime.sendMessage({ type: 'stream-host', streamId, url });
    if (!res?.ok) throw new Error(`Could not set up request headers for ${host}: ${res?.error ?? 'no response from background'}`);
    hosts.add(host);
  }

  // hls.js loader for every request of one stream: registers the host first (allowHost: url =>
  // Promise), and decodes image-disguised segments (see disguise.js) before the demuxer sees
  // them, calling onDisguised for each. A segment that's an image we can't decode, or a host we
  // can't register, fails loudly with the reason (onFail: message =>).
  function makeLoader({ allowHost, onDisguised, onFail }) {
    const unwrapping = (callbacks) => ({
      ...callbacks,
      onSuccess: (response, stats, ctx, details) => {
        // A "playlist" that isn't one (an HTML error page, an empty body) fails as a load error,
        // so hls.js retries it like any failed request.
        if (typeof response.data === 'string' && !response.data.trimStart().startsWith('#EXTM3U')) {
          const text = response.data.replace(/\s+/g, ' ').trim();
          const sent = text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : 'an empty body';
          return callbacks.onError({ code: response.code, text: `not a playlist (no #EXTM3U); server sent ${sent}` }, ctx, details, stats);
        }
        const bytes = response.data instanceof ArrayBuffer ? new Uint8Array(response.data) : null;
        if (!bytes || !StreamSnifferDisguise.isDisguised(bytes)) return callbacks.onSuccess(response, stats, ctx, details);
        StreamSnifferDisguise.decodeDisguisedSegment(bytes, browserCodecs).then(
          (ts) => {
            response.data = ts.buffer.slice(ts.byteOffset, ts.byteOffset + ts.byteLength);
            onDisguised();
            callbacks.onSuccess(response, stats, ctx, details);
          },
          (err) => {
            onFail(`Couldn't decode a segment: ${err.message}`);
            callbacks.onError({ code: 0, text: err.message }, ctx, details, stats);
          }
        );
      },
    });
    return class extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        this.cancelled = false;
        allowHost(context.url).then(
          () => {
            if (!this.cancelled) super.load(context, config, unwrapping(callbacks));
          },
          (err) => {
            onFail(err.message);
            callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
          }
        );
      }
      abort() {
        this.cancelled = true;
        super.abort();
      }
    };
  }

  // The value in list nearest to v if it's within tol of it, else v rounded. Measured rates
  // wobble a little; this snaps them to the usual one they're close to.
  function snapTo(v, list, tol) {
    const closest = list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    return Math.abs(closest - v) <= tol ? closest : Math.round(v);
  }
  const COMMON_FPS = [24, 25, 30, 48, 50, 60, 120];
  const snapFps = (fps) => snapTo(fps, COMMON_FPS, 1.5);

  // The index of the highest-bitrate level: the best quality a stream offers.
  const bestLevel = (levels) => levels.reduce((best, l, i) => (l.bitrate > levels[best].bitrate ? i : best), 0);

  // A video format's common name from its codec string(s), e.g. "avc1.640028" -> "H.264".
  function codecName(codecs) {
    const list = codecs.split(',').map((c) => c.trim());
    if (list.some((c) => /^(hvc1|hev1)/.test(c))) return 'HEVC';
    if (list.some((c) => /^av01/.test(c))) return 'AV1';
    if (list.some((c) => /^vp0?9/.test(c))) return 'VP9';
    if (list.some((c) => /^avc/.test(c))) return 'H.264';
    return '';
  }

  // "6.2 Mbps", or "850 kbps" under 1 Mbps.
  function rateText(mbps) {
    if (!mbps) return '';
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(mbps * 1000)} kbps`;
  }

  globalThis.StreamSnifferShared = { allowHost, makeLoader, snapTo, snapFps, bestLevel, rateText, codecName, COMMON_FPS };
})();
