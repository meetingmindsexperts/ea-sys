/**
 * The attendance report from our own webinar page (Nov 16, 2026; external
 * streams step 6): what one heartbeat adds, and the summary and CSV built from
 * the rows.
 */
import { describe, it, expect } from "vitest";
import { beatCouldCount, COUNTED_GAP_MAX_MS, presenceBeatEffect, REJOIN_GAP_MS } from "@/lib/webinar/presence-watch";
import { presenceReportCsv, presenceReportSummary, presenceSummaryFromGroups, timesJoined } from "@/lib/webinar/presence-report";

const now = new Date("2026-12-20T10:30:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const joined = (ms: number) => ({ phase: "joined", lastSeenAt: ago(ms) });

describe("presenceBeatEffect", () => {
  it("counts the gap between two live-view beats while the room is open", () => {
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(35_000), roomOpen: true, now })).toEqual({ watchedSeconds: 35, rejoined: false });
  });
  it("a gap just over the limit counts nothing, and is not yet a return", () => {
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(COUNTED_GAP_MAX_MS + 1000), roomOpen: true, now })).toEqual({ watchedSeconds: 0, rejoined: false });
  });
  it("past the return gap with the room open it is one more join, whichever beat says so", () => {
    const back = { watchedSeconds: 0, rejoined: true };
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(REJOIN_GAP_MS + 1000), roomOpen: true, now })).toEqual(back);
    // A reopened page beats "lobby" first, before it knows the room is open (review of d2200512).
    expect(presenceBeatEffect({ beatPhase: "lobby", previous: joined(REJOIN_GAP_MS + 1000), roomOpen: true, now })).toEqual(back);
  });
  it("a visit with the room closed (the closing screen, the replay next day) is not a join", () => {
    const none = { watchedSeconds: 0, rejoined: false };
    expect(presenceBeatEffect({ beatPhase: "lobby", previous: joined(24 * 3600_000), roomOpen: false, now })).toEqual(none);
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(REJOIN_GAP_MS + 1000), roomOpen: false, now })).toEqual(none);
  });
  it("someone who never reached the live view has nothing to return to", () => {
    expect(
      presenceBeatEffect({ beatPhase: "lobby", previous: { phase: "lobby", lastSeenAt: ago(REJOIN_GAP_MS + 1000) }, roomOpen: true, now }),
    ).toEqual({ watchedSeconds: 0, rejoined: false });
  });
  it("beatCouldCount: the room is asked only for a live-view beat, or a long gap, from someone who had joined", () => {
    expect(beatCouldCount({ beatPhase: "joined", previous: joined(30_000), now })).toBe(true);
    expect(beatCouldCount({ beatPhase: "lobby", previous: joined(REJOIN_GAP_MS + 1000), now })).toBe(true);
    expect(beatCouldCount({ beatPhase: "lobby", previous: joined(30_000), now })).toBe(false);
    expect(beatCouldCount({ beatPhase: "joined", previous: { phase: "lobby", lastSeenAt: ago(30_000) }, now })).toBe(false);
    expect(beatCouldCount({ beatPhase: "joined", previous: null, now })).toBe(false);
  });
  it("nothing for a lobby beat, the first beat, the escalation beat, a closed room, or a clock going backwards", () => {
    const none = { watchedSeconds: 0, rejoined: false };
    expect(presenceBeatEffect({ beatPhase: "lobby", previous: joined(30_000), roomOpen: true, now })).toEqual(none);
    expect(presenceBeatEffect({ beatPhase: "joined", previous: null, roomOpen: true, now })).toEqual(none);
    expect(presenceBeatEffect({ beatPhase: "joined", previous: { phase: "lobby", lastSeenAt: ago(30_000) }, roomOpen: true, now })).toEqual(none);
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(30_000), roomOpen: false, now })).toEqual(none);
    expect(presenceBeatEffect({ beatPhase: "joined", previous: joined(-5_000), roomOpen: true, now })).toEqual(none);
  });
});

describe("the report", () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    name: "Aisha Khan",
    email: "aisha@x.com",
    serialId: 7,
    firstJoinedAt: new Date("2026-12-20T09:55:00Z"),
    lastSeenAt: new Date("2026-12-20T11:02:00Z"),
    timesJoined: 2,
    watchedSeconds: 3_000,
    phase: "joined",
    ...extra,
  });

  it("someone only ever in the lobby has joined 0 times, whatever the row's count says", () => {
    expect(timesJoined({ phase: "lobby", joinCount: 1 })).toBe(0);
    expect(timesJoined({ phase: "joined", joinCount: 3 })).toBe(3);
  });

  it("the database's per-phase counts give the same summary", () => {
    expect(
      presenceSummaryFromGroups([
        { phase: "joined", _count: { _all: 2 }, _sum: { watchedSeconds: 4_000 } },
        { phase: "lobby", _count: { _all: 1 }, _sum: { watchedSeconds: 0 } },
      ]),
    ).toEqual({ opened: 3, joined: 2, totalWatchedSeconds: 4_000, avgWatchedSeconds: 2_000 });
    expect(presenceSummaryFromGroups([{ phase: "lobby", _count: { _all: 4 }, _sum: { watchedSeconds: null } }])).toEqual({
      opened: 4,
      joined: 0,
      totalWatchedSeconds: 0,
      avgWatchedSeconds: 0,
    });
  });

  it("the summary averages over the people who reached the live view", () => {
    expect(
      presenceReportSummary([row(), row({ watchedSeconds: 1_000 }), row({ phase: "lobby", watchedSeconds: 0 })]),
    ).toEqual({ opened: 3, joined: 2, totalWatchedSeconds: 4_000, avgWatchedSeconds: 2_000 });
    expect(presenceReportSummary([])).toEqual({ opened: 0, joined: 0, totalWatchedSeconds: 0, avgWatchedSeconds: 0 });
  });

  it("the CSV: times in the event's timezone (named in the header), minutes rounded, number padded", () => {
    const csv = presenceReportCsv([row()], "Asia/Dubai").split("\n");
    expect(csv[0]).toBe("Name,Email,Registration #,First on the page (Asia/Dubai),Last on the page (Asia/Dubai),Times joined,Minutes watched");
    expect(csv[1]).toBe("Aisha Khan,aisha@x.com,007,2026-12-20 13:55,2026-12-20 15:02,2,50");
  });

  it("a name typed as a formula is neutralised", () => {
    const csv = presenceReportCsv([row({ name: "=HYPERLINK(\"x\")" })], "Asia/Dubai");
    expect(csv.split("\n")[1].startsWith("\"'=HYPERLINK")).toBe(true);
  });
});
