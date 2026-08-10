/**
 * formatEventDateRange — the public agenda header (Aug 10, 2026).
 *
 * It used to hard-code `start – end` with date-fns, so a one-day event read
 * "August 11 – August 11, 2026" (organizer-reported), and it rendered in the
 * VIEWER's timezone while the same page grouped its sessions by the EVENT's
 * local date — the two could disagree either side of midnight.
 *
 * The single-day rule already existed for the {{eventDateRange}} email token
 * and was simply absent from the UI, so these pin the shared helper both
 * callers can now rely on.
 */
import { describe, it, expect } from "vitest";
import { formatEventDateRange } from "@/lib/event-time";

const DUBAI = "Asia/Dubai"; // UTC+4, no DST — stable arithmetic in assertions

describe("formatEventDateRange", () => {
  it("collapses a single-day event to one date", () => {
    // 08:00–13:00 UTC on the same Dubai day.
    const start = new Date("2026-08-11T08:00:00Z");
    const end = new Date("2026-08-11T13:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe("August 11, 2026");
  });

  it("does not repeat the month for a range inside one month", () => {
    const start = new Date("2026-08-11T08:00:00Z");
    const end = new Date("2026-08-14T13:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe("August 11 – 14, 2026");
  });

  it("names both months when the range crosses one", () => {
    const start = new Date("2026-08-28T08:00:00Z");
    const end = new Date("2026-09-02T13:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe(
      "August 28 – September 2, 2026",
    );
  });

  it("carries both years when the range crosses one", () => {
    const start = new Date("2026-12-30T08:00:00Z");
    const end = new Date("2027-01-02T13:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe(
      "December 30, 2026 – January 2, 2027",
    );
  });

  it("decides single-vs-range on the EVENT's calendar day, not UTC", () => {
    // 21:00 UTC on Aug 10 is 01:00 Dubai on Aug 11; 23:00 UTC is 03:00 Dubai,
    // still Aug 11. In UTC these look like one day (Aug 10); in Dubai they are
    // one day too, but a DIFFERENT one — so the rendered date must say the 11th.
    const start = new Date("2026-08-10T21:00:00Z");
    const end = new Date("2026-08-10T23:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe("August 11, 2026");
  });

  it("treats a UTC-midnight-crossing evening event as ONE event day", () => {
    // 20:00–22:00 UTC on Aug 11 spans no Dubai midnight (00:00–02:00 Aug 12).
    // Both instants land on Aug 12 in Dubai, so it stays a single day.
    const start = new Date("2026-08-11T20:00:00Z");
    const end = new Date("2026-08-11T22:00:00Z");
    expect(formatEventDateRange(start, end, DUBAI)).toBe("August 12, 2026");
  });

  it("falls back to the default timezone rather than throwing on a bad zone", () => {
    const start = new Date("2026-08-11T08:00:00Z");
    const end = new Date("2026-08-11T13:00:00Z");
    // resolveTimezone guards this; a public page must never blank out because
    // an event carries a malformed timezone string.
    expect(() => formatEventDateRange(start, end, "")).not.toThrow();
    expect(formatEventDateRange(start, end, "")).toContain("2026");
  });
});
