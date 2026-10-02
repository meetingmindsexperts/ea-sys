import { describe, it, expect } from "vitest";
import {
  encodeClockQr,
  formatDelay,
  median,
  parseClockQr,
  pickClockOffset,
  readingFromClock,
} from "@/lib/stream-latency";

describe("clock QR", () => {
  it("round-trips the server time", () => {
    expect(parseClockQr(encodeClockQr(1_759_400_000_123.4))).toBe(1_759_400_000_123);
  });

  it("ignores any other QR code (a badge, a URL)", () => {
    expect(parseClockQr("https://events.example.com")).toBeNull();
    expect(parseClockQr("EASYS-CLOCK:abc")).toBeNull();
    expect(parseClockQr("EASYS-CLOCK:-5")).toBeNull();
  });
});

describe("pickClockOffset", () => {
  it("uses the sample with the shortest round trip", () => {
    const offset = pickClockOffset([
      { sentAt: 1000, receivedAt: 1400, serverNow: 9000 }, // 400 ms round trip
      { sentAt: 2000, receivedAt: 2040, serverNow: 7020 }, // 40 ms: midpoint 2020
    ]);
    expect(offset).toBe(5000);
  });

  it("is null with no samples (server unreachable)", () => {
    expect(pickClockOffset([])).toBeNull();
  });
});

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("readingFromClock", () => {
  it("splits the total into Zoom's share and ours", () => {
    // Clock shown in the room at t=0; MediaMTX received that frame at 6 s;
    // it was on the preview screen at 14 s.
    expect(readingFromClock(0, 14_000, 6_000)).toEqual({ totalMs: 14_000, zoomMs: 6_000, oursMs: 8_000 });
  });

  it("gives only the total when the stream has no arrival stamps", () => {
    expect(readingFromClock(0, 14_000, null)).toEqual({ totalMs: 14_000, zoomMs: null, oursMs: null });
  });
});

describe("formatDelay", () => {
  it("formats seconds to one decimal and never shows a negative", () => {
    expect(formatDelay(7_240)).toBe("7.2 s");
    expect(formatDelay(-300)).toBe("0.0 s");
    expect(formatDelay(null)).toBe("n/a");
  });
});
