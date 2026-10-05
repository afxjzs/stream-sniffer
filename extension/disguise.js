// Some stream sites disguise their video segments as PNG images, served from image CDNs.
// The one format seen so far (Oct 2026) is an ordinary RGB PNG whose decoded pixel bytes are:
//
//   "TIKTIKPX"  +  uint32 big-endian length  +  gzip(MPEG-TS segment)
//
// This decodes that back to MPEG-TS. It's a classic script so the extension player can load it
// with a <script> tag, and the relay (Node) can import it; each passes in its own inflate/gunzip.
(function () {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const MAGIC = 'TIKTIKPX';
  const BYTES_PER_PIXEL = { 0: 1, 2: 3, 4: 2, 6: 4 }; // gray, RGB, gray+alpha, RGBA (8-bit)

  const isPng = (b) => b.length > 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // Reverses PNG's per-row filters (None, Sub, Up, Average, Paeth) to recover raw pixel bytes.
  function unfilter(raw, width, height, bpp) {
    const stride = width * bpp;
    const out = new Uint8Array(height * stride);
    for (let r = 0; r < height; r++) {
      const filter = raw[r * (stride + 1)];
      const src = r * (stride + 1) + 1;
      const row = r * stride;
      const prev = row - stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[row + x - bpp] : 0;
        const up = r > 0 ? out[prev + x] : 0;
        const c = r > 0 && x >= bpp ? out[prev + x - bpp] : 0;
        let pred;
        if (filter === 0) pred = 0;
        else if (filter === 1) pred = a;
        else if (filter === 2) pred = up;
        else if (filter === 3) pred = (a + up) >> 1;
        else if (filter === 4) {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        } else throw new Error(`image-disguised segment has an invalid PNG row filter (${filter})`);
        out[row + x] = (raw[src + x] + pred) & 0xff;
      }
    }
    return out;
  }

  // Returns the MPEG-TS bytes, null if `bytes` isn't a PNG (nothing to do), or throws if it is a
  // PNG but not one we can decode, so the caller can show why playback failed.
  async function decodeDisguisedSegment(bytes, { inflate, gunzip }) {
    if (!isPng(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width, height, depth, colorType, interlace;
    const idat = [];
    for (let off = 8; off + 8 <= bytes.length; ) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
      if (type === 'IHDR') {
        width = view.getUint32(off + 8);
        height = view.getUint32(off + 12);
        depth = bytes[off + 16];
        colorType = bytes[off + 17];
        interlace = bytes[off + 20];
      } else if (type === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len));
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    const bpp = BYTES_PER_PIXEL[colorType];
    if (depth !== 8 || interlace !== 0 || !bpp) {
      throw new Error(`image-disguised segment uses an unsupported PNG layout (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
    }
    const raw = await inflate(concat(idat));
    if (raw.length < height * (width * bpp + 1)) throw new Error('image-disguised segment: PNG pixel data is truncated');
    const px = unfilter(raw, width, height, bpp);
    const magic = String.fromCharCode(...px.subarray(0, MAGIC.length));
    if (magic !== MAGIC) {
      throw new Error(`segment is a PNG image, but not a disguise format Stream Sniffer knows (pixels start with ${hex(px.subarray(0, 12))})`);
    }
    const n = new DataView(px.buffer).getUint32(MAGIC.length);
    const ts = await gunzip(px.subarray(MAGIC.length + 4, MAGIC.length + 4 + n));
    if (ts[0] !== 0x47) throw new Error(`decoded image-disguised segment isn't MPEG-TS (starts with ${hex(ts.subarray(0, 4))})`);
    return ts;
  }

  globalThis.StreamSnifferDisguise = { isPng, decodeDisguisedSegment };
})();
