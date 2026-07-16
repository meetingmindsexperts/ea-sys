/**
 * Unit tests for src/lib/event-time.ts — the event-timezone helpers that
 * back session date-validation (REST + MCP) and public time rendering.
 * The load-bearing case is isSessionWithinEventDates: it must compare
 * LOCAL dates in the event's timezone, not the server's UTC — so an
 * early-morning or late-night session on a boundary day is accepted even
 * though its UTC instant falls on the adjacent calendar day.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_EVENT_TIMEZONE,
  resolveTimezone,
  localDateInTz,
  localDateTimeInTz,
  wallTimeInTzToDate,
  hourFractionInTz,
  isSessionWithinEventDates,
  formatTimeInTz,
  tzLabel,
} from "@/lib/event-time";

const DUBAI = "Asia/Dubai";
// Single-day event on 2026-06-17, Dubai time.
const evStart = new Date("2026-06-17T00:00:00+04:00");
const evEnd = new Date("2026-06-17T23:59:59+04:00");

describe("resolveTimezone", () => {
  it("falls back to the default for null/empty", () => {
    expect(resolveTimezone(null)).toBe(DEFAULT_EVENT_TIMEZONE);
    expect(resolveTimezone(undefined)).toBe(DEFAULT_EVENT_TIMEZONE);
    expect(resolveTimezone("")).toBe(DEFAULT_EVENT_TIMEZONE);
    expect(resolveTimezone("  ")).toBe(DEFAULT_EVENT_TIMEZONE);
    expect(resolveTimezone("America/New_York")).toBe("America/New_York");
  });
});

describe("localDateInTz", () => {
  it("returns the local calendar date in the given timezone", () => {
    // 21:00 UTC on the 16th is 01:00 on the 17th in Dubai.
    expect(localDateInTz(new Date("2026-06-16T21:00:00Z"), DUBAI)).toBe("2026-06-17");
    // 19:00 UTC on the 17th is 23:00 on the 17th in Dubai.
    expect(localDateInTz(new Date("2026-06-17T19:00:00Z"), DUBAI)).toBe("2026-06-17");
  });
});

describe("isSessionWithinEventDates", () => {
  it("accepts a late-night (11pm Dubai) session on a boundary day", () => {
    const start = new Date("2026-06-17T19:00:00Z"); // 23:00 Dubai
    const end = new Date("2026-06-17T19:30:00Z"); // 23:30 Dubai
    expect(isSessionWithinEventDates(start, end, evStart, evEnd, DUBAI)).toBe(true);
  });

  it("accepts an early-morning (1am Dubai) session whose UTC instant is the previous day", () => {
    // This is the exact case the old setHours/UTC logic wrongly rejected.
    const start = new Date("2026-06-16T21:00:00Z"); // 01:00 Dubai on the 17th
    const end = new Date("2026-06-16T22:00:00Z"); // 02:00 Dubai on the 17th
    expect(isSessionWithinEventDates(start, end, evStart, evEnd, DUBAI)).toBe(true);
  });

  it("rejects a session on the next local day", () => {
    const start = new Date("2026-06-18T06:00:00Z"); // 10:00 Dubai on the 18th
    const end = new Date("2026-06-18T07:00:00Z");
    expect(isSessionWithinEventDates(start, end, evStart, evEnd, DUBAI)).toBe(false);
  });

  it("rejects a session before the first local day", () => {
    const start = new Date("2026-06-16T05:00:00Z"); // 09:00 Dubai on the 16th
    const end = new Date("2026-06-16T06:00:00Z");
    expect(isSessionWithinEventDates(start, end, evStart, evEnd, DUBAI)).toBe(false);
  });

  it("falls back to the default timezone when none is given", () => {
    const start = new Date("2026-06-16T21:00:00Z"); // 01:00 Dubai = default
    const end = new Date("2026-06-16T22:00:00Z");
    expect(isSessionWithinEventDates(start, end, evStart, evEnd, "")).toBe(true);
  });
});

describe("formatTimeInTz", () => {
  it("renders the time in the event timezone", () => {
    expect(formatTimeInTz(new Date("2026-06-17T19:00:00Z"), DUBAI)).toBe("11:00 PM");
    expect(formatTimeInTz(new Date("2026-06-17T05:30:00Z"), DUBAI)).toBe("9:30 AM");
  });
});

describe("tzLabel", () => {
  it("returns a short timezone label", () => {
    expect(tzLabel(new Date("2026-06-17T12:00:00Z"), DUBAI)).toBe("GMT+4");
  });
});

describe("localDateTimeInTz", () => {
  it("renders the wall-clock datetime in the event timezone", () => {
    // 05:30 UTC = 09:30 Dubai
    expect(localDateTimeInTz(new Date("2026-06-17T05:30:00Z"), DUBAI)).toBe(
      "2026-06-17T09:30",
    );
    // 21:00 UTC on the 16th = 01:00 on the 17th in Dubai
    expect(localDateTimeInTz(new Date("2026-06-16T21:00:00Z"), DUBAI)).toBe(
      "2026-06-17T01:00",
    );
  });

  it("zero-pads and uses a 24h clock (datetime-local input contract)", () => {
    // 20:05 UTC = 00:05 Dubai — midnight must be "00", not "24"
    expect(localDateTimeInTz(new Date("2026-06-16T20:05:00Z"), DUBAI)).toBe(
      "2026-06-17T00:05",
    );
  });
});

describe("wallTimeInTzToDate", () => {
  it("interprets a wall-clock string in the event timezone", () => {
    // 09:30 Dubai = 05:30 UTC
    expect(wallTimeInTzToDate("2026-06-17T09:30", DUBAI).toISOString()).toBe(
      "2026-06-17T05:30:00.000Z",
    );
  });

  it("round-trips with localDateTimeInTz", () => {
    const instant = new Date("2026-06-17T19:45:00Z");
    const wall = localDateTimeInTz(instant, DUBAI);
    expect(wallTimeInTzToDate(wall, DUBAI).getTime()).toBe(instant.getTime());
  });

  it("handles DST timezones on both sides of the transition", () => {
    const NY = "America/New_York";
    // EST (UTC-5): Jan 15 09:00 New York = 14:00 UTC
    expect(wallTimeInTzToDate("2026-01-15T09:00", NY).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    // EDT (UTC-4): Jun 15 09:00 New York = 13:00 UTC
    expect(wallTimeInTzToDate("2026-06-15T09:00", NY).toISOString()).toBe(
      "2026-06-15T13:00:00.000Z",
    );
  });

  it("returns an invalid Date for malformed input", () => {
    expect(isNaN(wallTimeInTzToDate("not-a-date", DUBAI).getTime())).toBe(true);
    expect(isNaN(wallTimeInTzToDate("", DUBAI).getTime())).toBe(true);
  });
});

describe("hourFractionInTz", () => {
  it("returns the fractional hour-of-day in the event timezone", () => {
    // 05:30 UTC = 09:30 Dubai → 9.5
    expect(hourFractionInTz(new Date("2026-06-17T05:30:00Z"), DUBAI)).toBe(9.5);
    // 19:00 UTC = 23:00 Dubai → 23
    expect(hourFractionInTz(new Date("2026-06-17T19:00:00Z"), DUBAI)).toBe(23);
    // 20:00 UTC = 00:00 Dubai next day → 0 (not 24)
    expect(hourFractionInTz(new Date("2026-06-16T20:00:00Z"), DUBAI)).toBe(0);
  });
});
