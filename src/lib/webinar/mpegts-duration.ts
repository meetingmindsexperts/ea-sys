/**
 * How long one MPEG-TS piece of a recording plays, read from the timestamps
 * inside it (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §2.1).
 *
 * Why it is read and not worked out: the stream server cuts a piece at the
 * first keyframe after six seconds, so pieces run six to eight seconds, and
 * the gap between two pieces' start times counts any pause or drop in between
 * as video (a 1.3 second piece read as 13.4 on the throwaway server). The
 * replay's timeline is the sum of these, so each one must be the piece's own.
 *
 * Read in plain code rather than by `ffprobe`, so the worker image needs no
 * video tools for it. Within a frame of what `ffprobe` says, checked on pieces
 * the stream server wrote from a stream with B-frames (pinned by a test on a
 * small piece made the same way).
 *
 * The rule: every audio and video packet carries a presentation time (PTS) on
 * a 90 kHz clock. A piece plays from its earliest PTS to its latest PTS plus
 * one frame of the stream that ends last. A damaged packet is stepped over to
 * the next one. Pure; never throws. Null when nothing in it is timed; the
 * shipping job then falls back to the gap to the next piece (fallbackPieceMs).
 */

const PACKET = 188;
const SYNC = 0x47;
const CLOCK_HZ = 90_000;
/** PTS is a 33-bit count; it wraps about every 26.5 hours. */
const WRAP = 2 ** 33;

function isMediaStream(streamId: number): boolean {
  // MPEG audio and video stream ids (ISO 13818-1, table 2-22), and private stream 1 (0xBD), which
  // MediaMTX uses for Opus and AC-3 audio in MPEG-TS (review of 9592d2151).
  return (streamId >= 0xc0 && streamId <= 0xdf) || (streamId >= 0xe0 && streamId <= 0xef) || streamId === 0xbd;
}

/** The next packet boundary at or after `from`: a sync byte with another one a packet later. */
function resync(buf: Uint8Array, from: number): number {
  for (let at = from; at + PACKET <= buf.length; at++) {
    if (buf[at] === SYNC && (at + PACKET === buf.length || buf[at + PACKET] === SYNC)) return at;
  }
  return buf.length;
}

/** Where a packet's payload begins, or -1 when it has none. */
function payloadStart(buf: Uint8Array, at: number): number {
  const control = (buf[at + 3] >> 4) & 0x3;
  if ((control & 0x1) === 0) return -1;
  let start = at + 4;
  if (control & 0x2) start += 1 + buf[at + 4];
  return start < at + PACKET ? start : -1;
}

/** The PTS at the start of a PES packet, or null. */
function readPts(buf: Uint8Array, p: number, end: number): { streamId: number; pts: number } | null {
  if (p + 14 > end || buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) return null;
  const streamId = buf[p + 3];
  if (!isMediaStream(streamId) || (buf[p + 7] & 0x80) === 0) return null;
  const b = p + 9;
  const pts =
    ((buf[b] >> 1) & 0x07) * 2 ** 30 +
    buf[b + 1] * 2 ** 22 +
    ((buf[b + 2] >> 1) & 0x7f) * 2 ** 15 +
    buf[b + 3] * 2 ** 7 +
    (buf[b + 4] >> 1);
  return { streamId, pts };
}

/** Take a 33-bit time past a wrap, relative to the first one seen. */
function unwrap(pts: number, first: number): number {
  let v = pts;
  while (v - first < -WRAP / 2) v += WRAP;
  while (v - first > WRAP / 2) v -= WRAP;
  return v;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One stream's span: first and last PTS, and one frame's length. */
function span(times: number[]): { first: number; end: number } {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) steps.push(sorted[i] - sorted[i - 1]);
  return { first: sorted[0], end: sorted[sorted.length - 1] + median(steps) };
}

/**
 * The piece's length in milliseconds, or null when it holds no timed audio or
 * video at all (not MPEG-TS, or empty).
 */
export function mpegtsDurationMs(buf: Uint8Array): number | null {
  const byStream = new Map<number, number[]>();
  let first: number | null = null;
  for (let at = 0; at + PACKET <= buf.length; at += PACKET) {
    if (buf[at] !== SYNC) {
      // One damaged byte must not lose the piece's length (review of 9592d2151): find the next packet.
      at = resync(buf, at + 1) - PACKET;
      continue;
    }
    // Only the packet that begins a PES packet carries its header.
    if ((buf[at + 1] & 0x40) === 0) continue;
    const p = payloadStart(buf, at);
    if (p < 0) continue;
    const read = readPts(buf, p, at + PACKET);
    if (!read) continue;
    if (first === null) first = read.pts;
    const list = byStream.get(read.streamId) ?? [];
    list.push(unwrap(read.pts, first));
    byStream.set(read.streamId, list);
  }
  if (byStream.size === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const times of byStream.values()) {
    const s = span(times);
    start = Math.min(start, s.first);
    end = Math.max(end, s.end);
  }
  return Math.round(((end - start) / CLOCK_HZ) * 1000);
}
