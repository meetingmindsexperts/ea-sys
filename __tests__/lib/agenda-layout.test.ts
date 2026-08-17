import { describe, it, expect } from "vitest";
import { buildAgendaRows, roomOf, type LayoutSession } from "@/lib/agenda-layout";

/**
 * Fixtures are the REAL shapes read off production on 2026-08-17, because the
 * two cases that matter were both found in live data rather than imagined:
 * EHSMHC2026 has three halls on one identical clock, and BHS2026 has a workshop
 * that straddles two consecutive plenary sessions.
 */

function s(
  id: string,
  start: string,
  end: string,
  opts: { track?: string; type?: string; location?: string } = {},
): LayoutSession {
  return {
    id,
    startTime: `2026-10-02T${start}:00.000Z`,
    endTime: `2026-10-02T${end}:00.000Z`,
    type: opts.type ?? "SESSION",
    track: opts.track ? { name: opts.track, color: "#3B82F6" } : null,
    location: opts.location ?? null,
  };
}

describe("roomOf", () => {
  it("prefers the track, which is where every real event puts the hall", () => {
    expect(roomOf(s("a", "10:00", "11:00", { track: "Plenary Hall", location: "Level 3" }))).toBe(
      "Plenary Hall",
    );
  });

  it("falls back to location for a session where the hall was typed there instead", () => {
    // EHSMHC's Opening Ceremony is exactly this: location set, no track.
    expect(roomOf(s("a", "10:00", "11:00", { location: "Plenary Hall" }))).toBe("Plenary Hall");
  });

  it("is null when a session carries neither", () => {
    expect(roomOf(s("a", "10:00", "11:00"))).toBeNull();
  });
});

describe("buildAgendaRows — the ordinary single-track day", () => {
  it("emits consecutive sessions as singles, never a block", () => {
    const rows = buildAgendaRows([
      s("a", "09:00", "10:00", { track: "Plenary Hall" }),
      s("b", "10:00", "11:00", { track: "Plenary Hall" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["single", "single"]);
  });

  it("touching times are not an overlap: 10:00 end and 10:00 start stay separate", () => {
    // Mutation guard. A `<=` here would fuse every back-to-back session on a
    // single-track day into one giant block, i.e. break the common case.
    const rows = buildAgendaRows([
      s("a", "09:00", "10:00", { track: "Hall A" }),
      s("b", "10:00", "11:00", { track: "Hall B" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["single", "single"]);
  });

  it("orders rows by start time regardless of input order", () => {
    const rows = buildAgendaRows([
      s("late", "14:00", "15:00", { track: "Hall A" }),
      s("early", "09:00", "10:00", { track: "Hall A" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["early", "late"]);
  });
});

describe("buildAgendaRows — EHSMHC2026, three halls on one clock", () => {
  const day = [
    s("clinical", "10:15", "13:00", { track: "Plenary Hall" }),
    s("ws2", "10:15", "13:00", { track: "Workshop Hall II" }),
    s("ws1", "10:15", "13:00", { track: "Workshop Hall I" }),
  ];

  it("collapses them into one block of three columns", () => {
    const rows = buildAgendaRows(day);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row.kind !== "parallel") throw new Error("expected a parallel block");
    expect(row.columns).toHaveLength(3);
    expect(row.columns.map((c) => c.room)).toEqual([
      "Plenary Hall",
      "Workshop Hall I",
      "Workshop Hall II",
    ]);
  });

  it("spans the block from the earliest start to the latest end", () => {
    const [row] = buildAgendaRows(day);
    if (row.kind !== "parallel") throw new Error("expected a parallel block");
    expect(new Date(row.start).toISOString()).toBe("2026-10-02T10:15:00.000Z");
    expect(new Date(row.end).toISOString()).toBe("2026-10-02T13:00:00.000Z");
  });
});

describe("buildAgendaRows — BHS2026, a workshop straddling two sessions", () => {
  // Session V 11:25–12:20 and Session VI 12:20–13:15 in Plenary Hall, with a
  // workshop 11:40–13:00 alongside. Neither plenary session shares a start
  // time with the workshop, so equality-based grouping finds nothing at all.
  const day = [
    s("v", "11:25", "12:20", { track: "Plenary Hall" }),
    s("workshop", "11:40", "13:00", { track: "Workshop Room" }),
    s("vi", "12:20", "13:15", { track: "Plenary Hall" }),
  ];

  it("clusters all three, which an equal-start-time check would miss", () => {
    const rows = buildAgendaRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("parallel");
  });

  it("keys columns by HALL, so the two consecutive plenary talks share one", () => {
    // The load-bearing assertion. Keying by session would give three columns,
    // presenting Session V and Session VI as alternatives to each other when
    // they run back to back in the same room.
    const [row] = buildAgendaRows(day);
    if (row.kind !== "parallel") throw new Error("expected a parallel block");
    expect(row.columns).toHaveLength(2);
    const plenary = row.columns.find((c) => c.room === "Plenary Hall");
    expect(plenary?.sessions.map((x) => x.id)).toEqual(["v", "vi"]);
    expect(row.columns.find((c) => c.room === "Workshop Room")?.sessions).toHaveLength(1);
  });
});

describe("buildAgendaRows — breaks", () => {
  it("keeps a break as its own row, in time order", () => {
    const rows = buildAgendaRows([
      s("talk", "09:00", "10:00", { track: "Plenary Hall" }),
      s("coffee", "10:00", "10:30", { type: "BREAK" }),
      s("talk2", "10:30", "11:30", { track: "Plenary Hall" }),
    ]);
    expect(rows.map((r) => ({ kind: r.kind, key: r.key }))).toEqual([
      { kind: "single", key: "talk" },
      { kind: "break", key: "coffee" },
      { kind: "single", key: "talk2" },
    ]);
  });

  it("a break inside a long workshop does not split the block around it", () => {
    // Breaks are laid out apart from the programme and merged back by start
    // time precisely so this cannot happen.
    const rows = buildAgendaRows([
      s("long", "10:00", "13:00", { track: "Workshop Hall I" }),
      s("also", "10:00", "13:00", { track: "Workshop Hall II" }),
      s("coffee", "11:00", "11:15", { type: "BREAK" }),
    ]);
    const parallel = rows.filter((r) => r.kind === "parallel");
    expect(parallel).toHaveLength(1);
    if (parallel[0].kind !== "parallel") throw new Error("expected a parallel block");
    expect(parallel[0].columns).toHaveLength(2);
  });

  it("never pulls a break into a block, even when it overlaps one", () => {
    const rows = buildAgendaRows([
      s("a", "10:00", "12:00", { track: "Hall A" }),
      s("b", "10:00", "12:00", { track: "Hall B" }),
      s("lunch", "11:00", "11:30", { type: "LUNCH" }),
    ]);
    expect(rows.some((r) => r.kind === "break" && r.key === "lunch")).toBe(true);
  });
});

describe("buildAgendaRows — degenerate cases", () => {
  it("two overlapping sessions in the SAME hall stay singles, not a fake choice", () => {
    // A double-booked room is a scheduling conflict, not an option for the
    // attendee. Presenting it as "choose one" would be a lie.
    const rows = buildAgendaRows([
      s("a", "10:00", "11:00", { track: "Plenary Hall" }),
      s("b", "10:30", "11:30", { track: "Plenary Hall" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["single", "single"]);
  });

  it("filtering to one track gives back the plain list, not a one-column grid", () => {
    const rows = buildAgendaRows([s("clinical", "10:15", "13:00", { track: "Plenary Hall" })]);
    expect(rows.map((r) => r.kind)).toEqual(["single"]);
  });

  it("sorts a hall-less session to the end of the columns", () => {
    const [row] = buildAgendaRows([
      s("unroomed", "10:00", "11:00"),
      s("hall", "10:00", "11:00", { track: "Plenary Hall" }),
    ]);
    if (row.kind !== "parallel") throw new Error("expected a parallel block");
    expect(row.columns.map((c) => c.room)).toEqual(["Plenary Hall", null]);
  });

  it("handles an empty day", () => {
    expect(buildAgendaRows([])).toEqual([]);
  });
});
