import { describe, it, expect } from "vitest";
import type { CalendarDate } from "@/hr/lib/hr-date";
import { bridgeDays } from "@/hr/lib/hr-leave-bridge";
import { fillsWeekendBetween } from "@/hr/lib/hr-constants";

/**
 * Owner, Nov 3 2026: annual and maternity leave continuing from a Friday to the
 * Monday after is one absence, and the weekend between is charged. 2026-11-06
 * is a Friday, 2026-11-09 the Monday after.
 */
const weekend = (d: CalendarDate) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

function run(recorded: Record<string, string>, from: string, to = from, holidays: string[] = []) {
  return bridgeDays({
    from: from as CalendarDate,
    to: to as CalendarDate,
    code: "ML",
    recordedCode: (d) => recorded[d],
    isNonWorking: (d) => weekend(d) || holidays.includes(d),
  });
}

describe("bridgeDays", () => {
  it("Monday saved after Friday: fills Saturday and Sunday", () => {
    expect(run({ "2026-11-06": "ML" }, "2026-11-09")).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("Friday saved before Monday: fills forwards the same way", () => {
    expect(run({ "2026-11-09": "ML" }, "2026-11-06")).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("fills both sides when the range sits between two pieces", () => {
    expect(
      run({ "2026-11-06": "ML", "2026-11-16": "ML" }, "2026-11-09", "2026-11-13"),
    ).toEqual(["2026-11-07", "2026-11-08", "2026-11-14", "2026-11-15"]);
  });

  it("crosses a public-holiday break too (Eid, Mon 25 to Fri 29 May)", () => {
    const eid = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"];
    expect(run({ "2026-05-22": "ML" }, "2026-06-01", "2026-06-01", eid)).toHaveLength(9);
  });

  it("leaves the weekend alone when the other side is a different code", () => {
    expect(run({ "2026-11-06": "SL-F" }, "2026-11-09")).toEqual([]);
  });

  it("leaves the weekend alone when nothing is recorded on the other side", () => {
    expect(run({}, "2026-11-09")).toEqual([]);
  });

  it("never overwrites a recorded weekend day: on-duty Saturday stops it", () => {
    expect(run({ "2026-11-06": "ML", "2026-11-07": "OD" }, "2026-11-09")).toEqual([]);
  });

  it("does not reach across a working day", () => {
    // Thursday ML, Friday nothing (worked), Monday saved: no fill.
    expect(run({ "2026-11-05": "ML" }, "2026-11-09")).toEqual([]);
  });

  it("applies to annual and maternity leave only", () => {
    expect(fillsWeekendBetween("ANNUAL")).toBe(true);
    expect(fillsWeekendBetween("MATERNITY")).toBe(true);
    for (const c of ["SICK_FULL", "ON_DUTY", "COMP_OFF", "WORK", "UNPAID"] as const) {
      expect(fillsWeekendBetween(c)).toBe(false);
    }
  });
});
