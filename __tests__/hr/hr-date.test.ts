import { describe, it, expect } from "vitest";
import {
  addDays,
  dayOfWeek,
  daysBetween,
  eachDate,
  fromCalendarDate,
  isCalendarDate,
  isWithin,
  toCalendarDate,
} from "@/hr/lib/hr-date";
import {
  anniversaryOn,
  employedWindowInYear,
  hasCompletedFirstYear,
  isWithinEmployment,
  leaveYearBounds,
  nextAnniversary,
} from "@/hr/lib/hr-leave-year";

describe("calendar dates", () => {
  /**
   * `Date.UTC` rolls a bad date over silently, so "2026-02-31" parses happily as
   * 3 March. A leave tracker is fed by spreadsheet imports, where a typo of that
   * exact shape is realistic, and rolling it over would land somebody's leave on
   * the wrong day while reporting a clean import.
   */
  it("rejects right-shaped impossible dates", () => {
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-00-10")).toBe(false);
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // a real leap day
  });

  it("rejects anything that is not a bare ISO date", () => {
    for (const v of ["", "2026-1-1", "26-01-01", "2026-01-01T00:00:00Z", 20260101, null]) {
      expect(isCalendarDate(v)).toBe(false);
    }
  });

  it("round-trips through the Prisma boundary exactly", () => {
    const d = fromCalendarDate("2026-08-27");
    expect(d.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    expect(toCalendarDate(d)).toBe("2026-08-27");
  });

  /**
   * The whole reason this module works on strings. `getUTCDay` is the same
   * answer on every machine; `getDay` is not, and a weekend that moves by a day
   * on a non-UTC server is the exact bug the string representation prevents.
   */
  it("reads the weekday in UTC, so it cannot drift", () => {
    expect(dayOfWeek("2026-01-17")).toBe(6); // Saturday
    expect(dayOfWeek("2026-01-18")).toBe(0); // Sunday
    expect(dayOfWeek("2026-01-14")).toBe(3); // Wednesday
  });

  it("shifts across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
  });

  it("returns nothing for a reversed range rather than looping", () => {
    expect(eachDate("2026-01-05", "2026-01-01")).toEqual([]);
    expect(eachDate("2026-01-01", "2026-01-03")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("treats range bounds as inclusive", () => {
    expect(isWithin("2026-01-01", "2026-01-01", "2026-12-31")).toBe(true);
    expect(isWithin("2026-12-31", "2026-01-01", "2026-12-31")).toBe(true);
    expect(isWithin("2027-01-01", "2026-01-01", "2026-12-31")).toBe(false);
    expect(isWithin("2026-06-01", null, null)).toBe(true);
  });
});

describe("leave year and anniversary", () => {
  it("bounds a leave year to the calendar year", () => {
    expect(leaveYearBounds(2026)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  /**
   * The 29 February ruling, pinned. Someone who joined on a leap day has no
   * anniversary in three years out of four, and the two candidates (28 Feb and
   * 1 Mar) are both defensible. What is NOT defensible is two call sites
   * choosing differently, so the answer is decided in one place: 28 February.
   */
  it("resolves a leap-day anniversary to 28 February in a common year", () => {
    expect(anniversaryOn("2024-02-29", 2025)).toBe("2025-02-28");
    expect(anniversaryOn("2024-02-29", 2028)).toBe("2028-02-29"); // a leap year
    expect(hasCompletedFirstYear("2024-02-29", "2025-02-27")).toBe(false);
    expect(hasCompletedFirstYear("2024-02-29", "2025-02-28")).toBe(true);
  });

  /**
   * The entitlement gate MOVES. EMP021 is the live case: zero entitlement and a
   * balance of -23 until her first anniversary, then 30 and +7, with nobody
   * having edited anything.
   */
  it("flips on the anniversary date exactly", () => {
    expect(hasCompletedFirstYear("2025-10-16", "2026-10-15")).toBe(false);
    expect(hasCompletedFirstYear("2025-10-16", "2026-10-16")).toBe(true);
    expect(hasCompletedFirstYear("2025-09-01", "2026-08-31")).toBe(false);
    expect(hasCompletedFirstYear("2025-09-01", "2026-09-01")).toBe(true);
  });

  it("finds the next anniversary strictly after the given day", () => {
    expect(nextAnniversary("2010-03-15", "2026-03-14")).toBe("2026-03-15");
    // On the day itself the NEXT one is a year out, not today.
    expect(nextAnniversary("2010-03-15", "2026-03-15")).toBe("2027-03-15");
  });

  /**
   * The exit date is the last WORKING day and is inclusive. An exclusive reading
   * silently drops whatever somebody did on their final day.
   */
  it("includes the exit date in the employment window", () => {
    const e = { joiningDate: "2020-01-01", exitDate: "2026-09-30" };
    expect(isWithinEmployment("2026-09-30", e)).toBe(true);
    expect(isWithinEmployment("2026-10-01", e)).toBe(false);
    expect(isWithinEmployment("2019-12-31", e)).toBe(false);
  });

  it("clips the leave year to the part actually employed", () => {
    expect(employedWindowInYear(2026, { joiningDate: "2026-03-10", exitDate: null })).toEqual({
      from: "2026-03-10",
      to: "2026-12-31",
    });
    expect(
      employedWindowInYear(2026, { joiningDate: "2020-01-01", exitDate: "2026-09-30" }),
    ).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    // Employed entirely outside the year.
    expect(employedWindowInYear(2026, { joiningDate: "2027-01-01", exitDate: null })).toBeNull();
  });
});
