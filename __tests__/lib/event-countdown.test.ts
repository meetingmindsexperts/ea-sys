/**
 * eventCountdown — "N days to go", counted in CALENDAR DAYS in the EVENT's
 * timezone.
 *
 * Every bug this function can have lives on a boundary, and every one of them
 * is visible to the organizer:
 *
 *  - Measure elapsed time instead of dates and an event starting 9am tomorrow
 *    reads "0 days to go" at 11pm tonight.
 *  - Measure in the VIEWER's timezone and the same Dubai event reads a day
 *    apart for a colleague in London.
 *  - Treat the end DATE as the end INSTANT and a conference that runs until
 *    this evening is already "ended" this morning.
 *
 * So the tests are boundaries, not happy paths. Times are chosen so the UTC
 * instant and the Dubai (UTC+4) calendar date deliberately disagree.
 */
import { describe, it, expect } from "vitest";
import { eventCountdown } from "@/lib/event-time";

const DUBAI = "Asia/Dubai"; // UTC+4, no DST

describe("eventCountdown — upcoming", () => {
  it('calls the night before "Tomorrow", not "0 days"', () => {
    // 2026-10-23 21:00 Dubai (= 17:00Z). The event starts 09:00 Dubai the next
    // morning — 12 hours away. Elapsed-time arithmetic gives 0.5 → "0 days to
    // go"; calendar arithmetic gives the answer a human would.
    const c = eventCountdown(
      "2026-10-24T05:00:00Z", // 09:00 Dubai
      "2026-10-24T14:00:00Z",
      DUBAI,
      new Date("2026-10-23T17:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 1, label: "Tomorrow" });
  });

  it("counts whole days for a distant event", () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-24T14:00:00Z",
      DUBAI,
      new Date("2026-10-12T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 12, label: "12 days to go" });
  });

  it("uses the EVENT's timezone, not the viewer's", () => {
    // 2026-10-23 22:00 UTC is already 2026-10-24 02:00 in Dubai — the event's
    // start day. To a viewer in London it is still "tomorrow"; to the event it
    // is today. The event's calendar is the one that counts.
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-24T14:00:00Z",
      DUBAI,
      new Date("2026-10-23T22:00:00Z"),
    );
    expect(c.phase).toBe("ongoing"); // NOT "upcoming — 1 day"
  });

  it("falls back to Asia/Dubai when the event has no timezone", () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-24T14:00:00Z",
      null,
      new Date("2026-10-22T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 2 });
  });
});

describe("eventCountdown — ongoing", () => {
  it('reports "Day 2 of 3" mid-conference', () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z", // day 1
      "2026-10-26T14:00:00Z", // day 3
      DUBAI,
      new Date("2026-10-25T08:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "ongoing", day: 2, totalDays: 3, label: "Day 2 of 3" });
  });

  it('says "Today" for a single-day event, not "Day 1 of 1"', () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-24T14:00:00Z",
      DUBAI,
      new Date("2026-10-24T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "ongoing", label: "Today" });
  });

  it("is still ongoing on the MORNING of the last day", () => {
    // 08:00 Dubai on the final day, whose sessions run until the evening. An
    // end-INSTANT comparison would already call this event finished and hide
    // the countdown on the very day the organizer needs it most.
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-26T14:00:00Z", // 18:00 Dubai on the 26th
      DUBAI,
      new Date("2026-10-26T04:00:00Z"), // 08:00 Dubai, same day
    );
    expect(c).toMatchObject({ phase: "ongoing", day: 3, totalDays: 3 });
  });

  it("is STILL ongoing late on the last night, after the final session ends", () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-26T14:00:00Z", // last session ended 18:00 Dubai
      DUBAI,
      new Date("2026-10-26T18:00:00Z"), // 22:00 Dubai — same calendar day
    );
    expect(c.phase).toBe("ongoing");
  });
});

describe("eventCountdown — past", () => {
  it("flips to past on the day AFTER the end date", () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-26T14:00:00Z",
      DUBAI,
      new Date("2026-10-27T05:00:00Z"), // 09:00 Dubai, the 27th
    );
    expect(c).toMatchObject({ phase: "past", days: 1, label: "Ended yesterday" });
  });

  it("counts days since for an older event", () => {
    const c = eventCountdown(
      "2026-10-24T05:00:00Z",
      "2026-10-26T14:00:00Z",
      DUBAI,
      new Date("2026-11-05T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "past", days: 10, label: "Ended 10 days ago" });
  });
});

describe("eventCountdown — calendar edges", () => {
  it("crosses a month boundary correctly", () => {
    const c = eventCountdown(
      "2026-11-02T05:00:00Z",
      "2026-11-02T14:00:00Z",
      DUBAI,
      new Date("2026-10-30T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 3 });
  });

  it("crosses a year boundary correctly", () => {
    const c = eventCountdown(
      "2027-01-02T05:00:00Z",
      "2027-01-02T14:00:00Z",
      DUBAI,
      new Date("2026-12-28T06:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 5 });
  });

  it("is not thrown off by a DST transition in the event's timezone", () => {
    // Europe/London springs forward on 2026-03-29. A day-count that subtracts
    // local wall-clock times across that boundary loses an hour and can floor a
    // 7-day gap to 6. Date arithmetic on calendar dates cannot.
    const c = eventCountdown(
      "2026-04-02T09:00:00Z",
      "2026-04-02T17:00:00Z",
      "Europe/London",
      new Date("2026-03-26T09:00:00Z"),
    );
    expect(c).toMatchObject({ phase: "upcoming", days: 7 });
  });
});
