/**
 * Watch analytics on our own webinar page (Nov 23, 2026): the tally the page keeps, the minute marks,
 * the timeline and the console's breakdowns (src/lib/webinar/watch-analytics.ts, presence-report.ts).
 */
import { describe, it, expect } from "vitest";
import {
  boundedQuality,
  breakdown,
  emptyTally,
  epochMinute,
  minutesToMark,
  subtractTally,
  tallyIsEmpty,
  TIMELINE_MAX_MINUTES,
  watchingTimeline,
} from "@/lib/webinar/watch-analytics";
import { watchAnalytics, watchingRanges, type WatchAnalyticsRow } from "@/lib/webinar/presence-report";

const at = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 11, 20, h, m, s));

describe("the page's tally", () => {
  it("a beat that got through takes only what it carried: a stall that ended meanwhile goes with the next", () => {
    const sent = { stalls: 2, stallMs: 3_000, reconnects: 1 };
    const now = { stalls: 3, stallMs: 5_000, reconnects: 1 };
    expect(subtractTally(now, sent)).toEqual({ stalls: 1, stallMs: 2_000, reconnects: 0 });
    expect(tallyIsEmpty(subtractTally(sent, sent))).toBe(true);
    expect(tallyIsEmpty(emptyTally())).toBe(true);
  });

  it("the server rounds to seconds and bounds one beat", () => {
    expect(boundedQuality({ stalls: 1, stallMs: 1_600, reconnects: 0 })).toEqual({ stalls: 1, stallSeconds: 2, reconnects: 0 });
    expect(boundedQuality(undefined)).toEqual({ stalls: 0, stallSeconds: 0, reconnects: 0 });
  });
});

describe("minute marks", () => {
  it("a counted beat marks the previous beat's minute and its own, each once", () => {
    const prev = at(10, 0, 40);
    const now = at(10, 1, 10);
    expect(minutesToMark({ counted: true, previousSeenAt: prev, now, known: [] })).toEqual([epochMinute(prev), epochMinute(now)]);
    expect(minutesToMark({ counted: true, previousSeenAt: prev, now, known: [epochMinute(prev)] })).toEqual([epochMinute(now)]);
    expect(minutesToMark({ counted: true, previousSeenAt: at(10, 1, 0), now, known: [epochMinute(now)] })).toEqual([]);
  });

  it("a beat that counted nothing marks nothing", () => {
    expect(minutesToMark({ counted: false, previousSeenAt: at(10, 0), now: at(10, 1), known: [] })).toEqual([]);
  });
});

describe("the timeline", () => {
  it("counts each person once a minute and keeps the quiet minutes as 0", () => {
    const m = epochMinute(at(10, 0));
    const points = watchingTimeline([{ watchedMinutes: [m, m, m + 1] }, { watchedMinutes: [m + 1, m + 3] }]);
    expect(points.map((p) => p.watching)).toEqual([1, 2, 0, 1]);
    expect(points[0].at).toBe(at(10, 0).toISOString());
    expect(watchingTimeline([])).toEqual([]);
  });

  it("a stray minute days before is cut to the last day", () => {
    const m = epochMinute(at(10, 0));
    expect(watchingTimeline([{ watchedMinutes: [m - 5 * 24 * 60, m] }])).toHaveLength(TIMELINE_MAX_MINUTES);
  });
});

describe("watching ranges in the CSV", () => {
  it("runs of minutes become ranges in the event's timezone", () => {
    const m = epochMinute(at(10, 0));
    expect(watchingRanges([m + 2, m, m + 1, m + 10], "Asia/Dubai")).toBe("14:00-14:03, 14:10-14:11");
    expect(watchingRanges([], "Asia/Dubai")).toBe("");
  });
});

describe("the console's breakdowns", () => {
  const row = (extra: Partial<WatchAnalyticsRow> = {}): WatchAnalyticsRow => ({
    phase: "joined",
    deviceType: "desktop",
    browser: "Chrome",
    os: "Windows",
    viewMode: "stream",
    stallCount: 0,
    stallSeconds: 0,
    reconnectCount: 0,
    watchedMinutes: [],
    ...extra,
  });

  it("counts the people who reached the live view, largest first, and names a missing value Unknown", () => {
    expect(breakdown(["iOS", null, "iOS", "Android"])).toEqual([
      { label: "iOS", count: 2 },
      { label: "Android", count: 1 },
      { label: "Unknown", count: 1 },
    ]);
    const a = watchAnalytics([row(), row({ deviceType: "mobile", os: "iOS", browser: "Safari" }), row({ phase: "lobby" })]);
    expect(a.watched).toBe(2);
    expect(a.devices).toEqual([
      { label: "Computer", count: 1 },
      { label: "Phone", count: 1 },
    ]);
  });

  it("buffering is reported for our stream's viewers only, per system", () => {
    const a = watchAnalytics([
      row({ os: "iOS", stallCount: 4, stallSeconds: 30, reconnectCount: 1 }),
      row({ os: "iOS" }),
      row({ os: "Windows", stallCount: 1, stallSeconds: 2 }),
      row({ viewMode: "zoom", stallCount: 0 }),
    ]);
    expect(a.playback).toMatchObject({ streamViewers: 3, buffered: 2, stallSeconds: 32, reconnects: 1 });
    expect(a.playback.bySystem[0]).toEqual({ system: "iOS", viewers: 2, buffered: 1, stallSeconds: 30, reconnects: 1 });
    expect(a.viewModes).toEqual([
      { label: "Our stream", count: 3 },
      { label: "Zoom", count: 1 },
    ]);
  });
});
