/**
 * How long a recorded piece plays, read from its own timestamps (Nov 24,
 * 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §2.1). The fixture is a real
 * piece written by MediaMTX 1.17.1 from a stream with B-frames and audio, at
 * 160x90 so it is small; ffprobe gives it 6.104689 seconds. On six full-size
 * pieces the same way the reader matched ffprobe to the millisecond.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mpegtsDurationMs } from "@/lib/webinar/mpegts-duration";

const piece = readFileSync(path.join(process.cwd(), "__tests__/fixtures/stream-recording/piece.mpegts"));

/** One 188-byte packet starting a PES packet on `pid` with this PTS. */
function pesPacket(pid: number, streamId: number, pts: number): Buffer {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x40 | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10; // payload only
  const h = 4;
  p.set([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5], h);
  const hi = Math.floor(pts / 2 ** 30) & 0x07;
  const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
  const lo = pts % 2 ** 15;
  p[h + 9] = 0x21 | (hi << 1);
  p[h + 10] = mid >> 7;
  p[h + 11] = ((mid & 0x7f) << 1) | 1;
  p[h + 12] = lo >> 7;
  p[h + 13] = ((lo & 0x7f) << 1) | 1;
  return p;
}
/** A video stream at 25 frames a second: 3,600 ticks of the 90 kHz clock per frame. */
const video = (frames: number[], base = 0) => Buffer.concat(frames.map((f) => pesPacket(256, 0xe0, (base + f * 3600) % 2 ** 33)));

describe("mpegtsDurationMs", () => {
  it("reads a real piece as ffprobe does", () => {
    expect(mpegtsDurationMs(piece)).toBe(6105);
  });

  it("frames in decode order (B-frames come out of order) still give first frame to last frame, plus one", () => {
    // Ten frames, one second at 25 fps less nothing: 0 to 9, plus one frame = 400 ms.
    expect(mpegtsDurationMs(video([0, 3, 1, 2, 6, 4, 5, 9, 7, 8]))).toBe(400);
  });

  it("keeps counting across the 33-bit clock's wrap, which comes about every 26.5 hours", () => {
    const nearWrap = 2 ** 33 - 3 * 3600;
    expect(mpegtsDurationMs(video([0, 1, 2, 3, 4, 5], nearWrap))).toBe(240);
  });

  it("takes the stream that ends last: audio running past the video counts", () => {
    // Audio every 1,920 ticks (a 1,024-sample AAC frame at 48 kHz) from 0 to 15,360.
    const audio = Array.from({ length: 9 }, (_, i) => pesPacket(257, 0xc0, i * 1920));
    const buf = Buffer.concat([video([0, 1, 2, 3]), ...audio]);
    // Video ends at 4 x 3,600 = 14,400 ticks (160 ms); audio at 15,360 + 1,920 = 17,280 (192 ms).
    expect(mpegtsDurationMs(buf)).toBe(192);
  });

  it("a piece cut short reads as what it holds, and a tail that is not a whole packet is ignored", () => {
    const half = piece.subarray(0, Math.floor(piece.length / 2 / 188) * 188);
    const short = mpegtsDurationMs(half);
    expect(short).toBeGreaterThan(2000);
    expect(short).toBeLessThan(4000);
    expect(mpegtsDurationMs(piece.subarray(0, piece.length - 50))).toBe(6105);
  });

  it("null for what is not MPEG-TS, for nothing, and for packets with no timed audio or video", () => {
    expect(mpegtsDurationMs(Buffer.from("not a transport stream at all".repeat(20)))).toBeNull();
    expect(mpegtsDurationMs(Buffer.alloc(0))).toBeNull();
    const noPes = Buffer.alloc(188 * 3, 0xff);
    for (let i = 0; i < 3; i++) noPes[i * 188] = 0x47;
    expect(mpegtsDurationMs(noPes)).toBeNull();
  });
});
