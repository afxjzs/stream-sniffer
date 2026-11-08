// MPEG-TS timestamps: reading a segment's start time, and shifting every timestamp in it.
//
// Two live streams carry unrelated timestamps (one game's clock can be hours ahead of
// another's). When the TV moves from one to the other, players that pace themselves by
// timestamps (Jellyfin's ffmpeg with -re) wait out the jump and freeze. The relay shifts each
// stretch of segments so the TV sees one continuous clock.
//
// Timestamps are 33-bit counts of a 90 kHz clock and wrap around at 2^33.

const WRAP = 2 ** 33;
const PACKET = 188;

const wrap = (t) => ((t % WRAP) + WRAP) % WRAP;

// A PTS or DTS field: 5 bytes, 33 bits spread around marker bits.
function readTs(b, i) {
  return (((b[i] >> 1) & 0x07) * 2 ** 30) + (b[i + 1] << 22) + ((b[i + 2] >> 1) << 15) + (b[i + 3] << 7) + (b[i + 4] >> 1);
}
function writeTs(b, i, t) {
  b[i] = (b[i] & 0xf1) | (Math.floor(t / 2 ** 30) & 0x07) << 1 | 1;
  b[i + 1] = (t >>> 22) & 0xff;
  b[i + 2] = ((t >>> 15) & 0x7f) << 1 | 1;
  b[i + 3] = (t >>> 7) & 0xff;
  b[i + 4] = (t & 0x7f) << 1 | 1;
}
// A PCR's 33-bit base (its 9-bit extension is left as it is).
function readPcr(b, i) {
  return b[i] * 2 ** 25 + (b[i + 1] << 17) + (b[i + 2] << 9) + (b[i + 3] << 1) + (b[i + 4] >> 7);
}
function writePcr(b, i, t) {
  b[i] = Math.floor(t / 2 ** 25) & 0xff;
  b[i + 1] = (t >>> 17) & 0xff;
  b[i + 2] = (t >>> 9) & 0xff;
  b[i + 3] = (t >>> 1) & 0xff;
  b[i + 4] = ((t & 1) << 7) | (b[i + 4] & 0x7f);
}

// Calls onPts(byteIndex) for each PTS/DTS field and onPcr(byteIndex) for each PCR in the
// segment. Throws if it isn't MPEG-TS, so a bad segment never goes out half-shifted.
function eachTimestamp(b, onPts, onPcr) {
  if (b.length < PACKET || b.length % PACKET !== 0) throw new Error(`not MPEG-TS: ${b.length} bytes is not a whole number of 188-byte packets`);
  for (let p = 0; p < b.length; p += PACKET) {
    if (b[p] !== 0x47) throw new Error(`not MPEG-TS: no sync byte at packet ${p / PACKET}`);
    const afc = (b[p + 3] >> 4) & 0x03;
    let payload = p + 4;
    if (afc & 0x02) {
      const afLen = b[p + 4];
      if (afLen > 0 && b[p + 5] & 0x10) onPcr(p + 6);
      payload = p + 5 + afLen;
    }
    // A PES packet starts here: 00 00 01, stream id, length, then its optional header.
    const end = p + PACKET;
    if (!(afc & 0x01) || !(b[p + 1] & 0x40) || payload + 9 > end) continue;
    if (b[payload] !== 0 || b[payload + 1] !== 0 || b[payload + 2] !== 1) continue;
    const sid = b[payload + 3];
    // These stream types have no optional header (no timestamps).
    if (sid === 0xbc || sid === 0xbe || sid === 0xbf || sid === 0xf0 || sid === 0xf1 || sid === 0xff || sid === 0xf2 || sid === 0xf8) continue;
    const flags = b[payload + 7] >> 6;
    if (flags & 0x02 && payload + 14 <= end) onPts(payload + 9);
    if (flags === 0x03 && payload + 19 <= end) onPts(payload + 14);
  }
}

/** The earliest PTS/DTS in a segment (its start, on its own clock), or null if it has none. */
export function firstTimestamp(segment) {
  let min = null;
  eachTimestamp(segment, (i) => {
    const t = readTs(segment, i);
    if (min === null || t < min) min = t;
  }, () => {});
  return min;
}

/** A copy of the segment with every PTS, DTS and PCR moved by offset (90 kHz ticks). */
export function shiftTimestamps(segment, offset) {
  const b = Buffer.from(segment);
  eachTimestamp(b, (i) => writeTs(b, i, wrap(readTs(b, i) + offset)), (i) => writePcr(b, i, wrap(readPcr(b, i) + offset)));
  return b;
}

export const TICKS_PER_SECOND = 90000;
export { wrap as wrapTimestamp };
