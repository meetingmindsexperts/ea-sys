import { describe, it, expect } from "vitest";
import {
  type BalanceEntry,
  capCarryover,
  computeLeaveBalance,
  planYearRoll,
} from "@/hr/lib/leave-balance";
import { effectiveStatusFor } from "@/hr/lib/hr-effective-status";

const YEAR = 2026;
const END = "2026-12-31";

/** N annual-leave days starting from a date, skipping nothing: the count is what matters. */
function annual(count: number, from = "2026-03-02"): BalanceEntry[] {
  const out: BalanceEntry[] = [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  for (let i = 0; i < count; i++) {
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      category: "ANNUAL",
      dayWeight: 1,
    });
  }
  return out;
}

function balanceFor(over: Partial<Parameters<typeof computeLeaveBalance>[0]> = {}) {
  return computeLeaveBalance({
    employee: {
      joiningDate: "2010-01-04",
      exitDate: null,
      carryoverDays: 0,
      openingSickUsed: 0,
      openingCompOff: 0,
    },
    leaveYear: YEAR,
    asOf: END,
    entries: [],
    ...over,
  });
}

describe("annual leave, against the real reconciliation baseline", () => {
  /**
   * EMP001 Leena: entitlement 30, taken 45, balance -15.
   *
   * This case fails if the leave year is scoped to the SERVICE year rather than
   * the calendar year, which is exactly the mistake the first draft of the plan
   * made. It also fails if anything clamps a negative.
   */
  it("EMP001: 30 entitlement, 45 taken, balance -15", () => {
    const b = balanceFor({ entries: annual(45) });
    expect(b.annual.entitlement).toBe(30);
    expect(b.annual.taken).toBe(45);
    expect(b.annual.balance).toBe(-15);
  });

  /**
   * EMP021 Adelina: entitlement 0 because her first anniversary has not passed,
   * 23 taken, balance -23. Fails if the first-year gate is missing (she would
   * read +7) and fails differently if a negative is floored (she would read 0).
   */
  it("EMP021: no entitlement before the first anniversary, balance -23", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2026-02-01",
        exitDate: null,
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      asOf: "2026-08-27",
      entries: annual(23, "2026-03-02"),
    });
    expect(b.hasCompletedFirstYear).toBe(false);
    expect(b.annual.entitlement).toBe(0);
    expect(b.annual.balance).toBe(-23);
  });

  it("EMP021 the day after her anniversary: entitlement 30, balance +7", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2026-02-01",
        exitDate: null,
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      asOf: "2027-02-01",
      entries: annual(23, "2026-03-02"),
    });
    expect(b.annual.entitlement).toBe(30);
    expect(b.annual.balance).toBe(7);
  });

  /**
   * EMP014 Krishna: 9.5 annual taken, 1.5 in the full-pay sick tier. Fails if
   * half-day weighting is wrong in either path, and the two paths are separate
   * code, so one can be right while the other is not.
   */
  it("EMP014: half days weigh 0.5 in both the annual and the sick path", () => {
    const b = balanceFor({
      entries: [
        ...annual(9),
        { date: "2026-04-01", category: "ANNUAL", dayWeight: 0.5 },
        { date: "2026-05-04", category: "SICK_FULL", dayWeight: 1 },
        { date: "2026-05-05", category: "SICK_FULL", dayWeight: 0.5 },
      ],
    });
    expect(b.annual.taken).toBe(9.5);
    expect(b.annual.balance).toBe(20.5);
    expect(b.sick.full.used).toBe(1.5);
    expect(b.sick.full.remaining).toBe(13.5);
  });

  it("adds carryover on top of the entitlement", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: null,
        carryoverDays: 5,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      entries: annual(45),
    });
    expect(b.annual.carriedIn).toBe(5);
    expect(b.annual.balance).toBe(-10);
  });
});

describe("the leave year is the calendar year", () => {
  it("ignores leave taken in the previous December", () => {
    const b = balanceFor({
      entries: [
        { date: "2025-12-30", category: "ANNUAL", dayWeight: 1 },
        { date: "2026-01-05", category: "ANNUAL", dayWeight: 1 },
      ],
    });
    expect(b.annual.taken).toBe(1);
  });

  /**
   * Exit on 30 September: leave on the 28th and 29th counts, and a row dated
   * 5 October does not. The write path rejects out-of-window entries outright;
   * this is the reader refusing to count one that got in another way.
   */
  it("stops counting at the exit date, inclusively", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: "2026-09-30",
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      entries: [
        { date: "2026-09-28", category: "ANNUAL", dayWeight: 1 },
        { date: "2026-09-29", category: "ANNUAL", dayWeight: 1 },
        { date: "2026-09-30", category: "ANNUAL", dayWeight: 1 },
        { date: "2026-10-05", category: "ANNUAL", dayWeight: 1 },
      ],
    });
    expect(b.annual.taken).toBe(3);
  });

  it("does not count leave dated before the joining date", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2026-03-10",
        exitDate: null,
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      asOf: END,
      entries: [
        { date: "2026-02-01", category: "ANNUAL", dayWeight: 1 },
        { date: "2026-03-11", category: "ANNUAL", dayWeight: 1 },
      ],
    });
    expect(b.annual.taken).toBe(1);
  });
});

describe("carryover cap: one direction only", () => {
  /**
   * The asymmetry IS the policy (owner, Aug 27 2026). Capping a debt would
   * forgive it, cancelling the companion ruling that leave taken in advance
   * follows the employee into the new year. A symmetric clamp is the tidy-up
   * that would silently write off every advance.
   */
  it("caps a positive at 30 and never floors a negative", () => {
    expect(capCarryover(45)).toBe(30);
    expect(capCarryover(30)).toBe(30);
    expect(capCarryover(12.5)).toBe(12.5);
    expect(capCarryover(-15)).toBe(-15);
    expect(capCarryover(-99)).toBe(-99);
  });

  it("shows both the capped and the stored figure, so a trim is visible", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: null,
        carryoverDays: 45,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
    });
    expect(b.annual.carriedIn).toBe(30);
    expect(b.annual.carriedInStored).toBe(45);
    expect(b.annual.balance).toBe(60);
  });
});

describe("year-end roll", () => {
  it("carries a negative balance forward in full", () => {
    const closing = balanceFor({ entries: annual(45) }); // -15
    expect(planYearRoll(closing)).toEqual({
      fromYear: 2026,
      toYear: 2027,
      carryForwardDays: -15,
      capped: false,
    });
  });

  it("caps a large positive balance and says that it capped", () => {
    const closing = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: null,
        carryoverDays: 20,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      entries: [],
    }); // 30 + 20 - 0 = 50
    expect(planYearRoll(closing)).toMatchObject({ carryForwardDays: 30, capped: true });
  });
});

describe("sick tiers", () => {
  it("keeps the three Art. 31 tiers separate", () => {
    const b = balanceFor({
      entries: [
        { date: "2026-02-02", category: "SICK_FULL", dayWeight: 1 },
        { date: "2026-02-03", category: "SICK_HALF", dayWeight: 1 },
        { date: "2026-02-04", category: "SICK_UNPAID", dayWeight: 1 },
      ],
    });
    expect(b.sick.full).toEqual({ used: 1, limit: 15, remaining: 14 });
    expect(b.sick.half).toEqual({ used: 1, limit: 30, remaining: 29 });
    expect(b.sick.unpaid).toEqual({ used: 1, limit: 45, remaining: 44 });
  });

  /**
   * Over-use of a tier is a data problem (HR coded the wrong thing), and it is
   * shown rather than hidden, because a remaining of 0 would look like a tidy
   * boundary instead of the mistake it is.
   */
  it("reports a negative remainder when a tier is over-used", () => {
    const b = balanceFor({
      entries: Array.from({ length: 20 }, (_, i) => ({
        date: `2026-02-${String(i + 1).padStart(2, "0")}`,
        category: "SICK_FULL" as const,
        dayWeight: 1,
      })),
    });
    expect(b.sick.full.remaining).toBe(-5);
  });
});

describe("comp-off inside the balance", () => {
  it("is a running balance, opening plus earned minus taken, never floored", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: null,
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      entries: [
        { date: "2026-01-17", category: "ON_DUTY", dayWeight: 1 },
        { date: "2026-01-18", category: "ON_DUTY", dayWeight: 1 },
        { date: "2026-03-02", category: "COMP_OFF", dayWeight: 1 },
        { date: "2026-03-03", category: "COMP_OFF", dayWeight: 1 },
        { date: "2026-03-04", category: "COMP_OFF", dayWeight: 1 },
      ],
    });
    expect(b.compOff.earned).toBe(1);
    expect(b.compOff.taken).toBe(3);
    // EMP011, EMP015, EMP016 and EMP022 are all negative in the live data.
    expect(b.compOff.balance).toBe(-2);
  });

  it("counts the opening balance as earned", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: null,
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 2,
      },
      entries: [],
    });
    expect(b.compOff.balance).toBe(2);
  });

  it("earns nothing from an OD day after the exit date", () => {
    const b = balanceFor({
      employee: {
        joiningDate: "2010-01-04",
        exitDate: "2026-01-17",
        carryoverDays: 0,
        openingSickUsed: 0,
        openingCompOff: 0,
      },
      entries: [
        { date: "2026-01-17", category: "ON_DUTY", dayWeight: 1 },
        { date: "2026-01-18", category: "ON_DUTY", dayWeight: 1 },
      ],
    });
    // The Sunday falls outside employment, so the weekend was not fully worked.
    expect(b.compOff.earned).toBe(0);
  });
});

describe("effective status for a day with no row", () => {
  const ctx = {
    employment: { joiningDate: "2026-01-01", exitDate: "2026-09-30" },
    entriesByDate: new Map([["2026-01-17", { code: "OD" }]]),
    holidays: new Set(["2026-01-02"]),
  };

  it("derives a weekend as OFF and an ordinary day as P", () => {
    expect(effectiveStatusFor("2026-01-10", ctx)).toEqual({
      date: "2026-01-10",
      code: "OFF",
      derived: true,
    });
    expect(effectiveStatusFor("2026-01-08", ctx)).toEqual({
      date: "2026-01-08",
      code: "P",
      derived: true,
    });
  });

  it("derives a public holiday as PH", () => {
    expect(effectiveStatusFor("2026-01-02", ctx).code).toBe("PH");
  });

  /**
   * The precedence that makes OD useful at all: an explicit entry beats the
   * derived weekend, or working a Saturday could never be recorded.
   */
  it("lets an explicit entry override the derived weekend", () => {
    expect(effectiveStatusFor("2026-01-17", ctx)).toEqual({
      date: "2026-01-17",
      code: "OD",
      derived: false,
    });
  });

  it("says nothing about days outside the employment window", () => {
    expect(effectiveStatusFor("2025-12-31", ctx).code).toBe("NOT_EMPLOYED");
    expect(effectiveStatusFor("2026-10-01", ctx).code).toBe("NOT_EMPLOYED");
  });
});

/**
 * Review H1 (Aug 31 2026). `employedWindowInYear` returns null when the
 * employment window and the leave year do not overlap. The engine used to turn
 * that into `from = null, to = null`, and `isWithin(date, null, null)` is true
 * for every entry, so a 2025 leaver's 2026 row summed their ENTIRE history
 * against a fresh 30. Reachable from "Show leavers" for anyone whose exit
 * preceded the year, and for every 2026 leaver from 1 January 2027.
 */
describe("a year the person was not employed in", () => {
  const history: BalanceEntry[] = [
    { date: "2024-03-04", category: "ANNUAL", dayWeight: 1 },
    { date: "2025-02-10", category: "ANNUAL", dayWeight: 1 },
    { date: "2025-02-11", category: "ANNUAL", dayWeight: 1 },
    { date: "2025-04-01", category: "SICK_FULL", dayWeight: 1 },
  ];
  const leaver = {
    joiningDate: "2020-01-15",
    exitDate: "2025-06-30",
    carryoverDays: 4,
    openingSickUsed: 2,
    openingCompOff: 0,
  };

  it("is flagged, and counts NOTHING rather than everything", () => {
    const b = computeLeaveBalance({ employee: leaver, leaveYear: 2026, asOf: "2026-08-31", entries: history });
    expect(b.employedInYear).toBe(false);
    expect(b.annual.entitlement).toBe(0);
    expect(b.annual.carriedIn).toBe(0);
    expect(b.annual.taken).toBe(0);
    expect(b.annual.balance).toBe(0);
    expect(b.sick.full.used).toBe(0);
    expect(b.sick.half.used).toBe(0);
  });

  it("the year they actually left in is unchanged", () => {
    const b = computeLeaveBalance({ employee: leaver, leaveYear: 2025, asOf: "2026-08-31", entries: history });
    expect(b.employedInYear).toBe(true);
    expect(b.annual.taken).toBe(2);
    expect(b.sick.full.used).toBe(3); // 1 recorded + 2 opening
  });

  it("a joiner dated after the year is treated the same way", () => {
    const b = computeLeaveBalance({
      employee: { joiningDate: "2027-02-01", exitDate: null, carryoverDays: 0, openingSickUsed: 0, openingCompOff: 0 },
      leaveYear: 2026,
      asOf: "2026-08-31",
      entries: [{ date: "2027-03-01", category: "ANNUAL", dayWeight: 1 }],
    });
    expect(b.employedInYear).toBe(false);
    expect(b.annual.taken).toBe(0);
    expect(b.annual.balance).toBe(0);
  });

  it("an agreed entitlement cannot make an unemployed year worth anything", () => {
    const b = computeLeaveBalance({
      employee: { ...leaver, annualEntitlementDays: 12 },
      leaveYear: 2026,
      asOf: "2026-08-31",
      entries: history,
    });
    expect(b.annual.entitlement).toBe(0);
    expect(b.annual.entitlementOverridden).toBe(false);
  });
});

/**
 * Review H2 (Aug 31 2026). The first-year gate was judged at `asOf`, so a
 * leaver who left after eleven months flipped from 0 to 30 on the leavers view
 * the day the calendar passed an anniversary they never reached. Owner ruling
 * the same day: "zero, unless first year is completed", leaver or not.
 */
describe("the first-year gate stops at the exit date", () => {
  const elevenMonths = {
    joiningDate: "2025-09-15",
    exitDate: "2026-08-15",
    carryoverDays: 0,
    openingSickUsed: 0,
    openingCompOff: 0,
  };
  const one: BalanceEntry[] = [{ date: "2026-05-04", category: "ANNUAL", dayWeight: 1 }];

  it("stays at zero after the would-be anniversary", () => {
    for (const asOf of ["2026-09-15", "2026-10-01", "2026-12-31"]) {
      const b = computeLeaveBalance({ employee: elevenMonths, leaveYear: 2026, asOf, entries: one });
      expect(b.hasCompletedFirstYear, asOf).toBe(false);
      expect(b.annual.entitlement, asOf).toBe(0);
      expect(b.annual.balance, asOf).toBe(-1);
    }
  });

  it("a leaver who DID complete the year before leaving keeps the 30", () => {
    const b = computeLeaveBalance({
      employee: { ...elevenMonths, exitDate: "2026-10-31" },
      leaveYear: 2026,
      asOf: "2026-12-31",
      entries: one,
    });
    expect(b.hasCompletedFirstYear).toBe(true);
    expect(b.annual.entitlement).toBe(30);
  });

  it("someone still employed is judged at asOf, as before", () => {
    const b = computeLeaveBalance({
      employee: { ...elevenMonths, exitDate: null },
      leaveYear: 2026,
      asOf: "2026-09-15",
      entries: one,
    });
    expect(b.hasCompletedFirstYear).toBe(true);
    expect(b.annual.entitlement).toBe(30);
  });
});

/**
 * Review H6 (Aug 31 2026). The go-live seeds (`carryoverDays`,
 * `openingSickUsed`) were applied to EVERY leave year because nothing recorded
 * which year they belonged to, and `LeaveGrant` was never read. On 1 January
 * every overdraft or surplus would have vanished and the opening sick figure
 * charged again. The seeds now count in `seedLeaveYear` only; any other year
 * reads its carry-in from the grant the year-end roll wrote.
 */
describe("the go-live seeds belong to one year", () => {
  const seeded = {
    joiningDate: "2020-01-15",
    exitDate: null,
    carryoverDays: 4,
    openingSickUsed: 2,
    openingCompOff: 1,
    seedLeaveYear: 2026,
  };
  const sick2027: BalanceEntry[] = [{ date: "2027-03-02", category: "SICK_FULL", dayWeight: 1 }];

  it("count in their own year", () => {
    const b = computeLeaveBalance({ employee: seeded, leaveYear: 2026, asOf: "2026-12-31", entries: [] });
    expect(b.annual.carriedIn).toBe(4);
    expect(b.sick.full.used).toBe(2);
  });

  it("do NOT count in the next year: no grant means nothing carried in", () => {
    const b = computeLeaveBalance({ employee: seeded, leaveYear: 2027, asOf: "2027-06-30", entries: sick2027 });
    expect(b.annual.carriedIn).toBe(0);
    expect(b.annual.balance).toBe(30);
    expect(b.sick.full.used).toBe(1);
    // Comp-off is a running balance, so its opening figure is not year-bound.
    expect(b.compOff.opening).toBe(1);
  });

  it("a grant written by the roll is what the next year carries in", () => {
    const b = computeLeaveBalance({
      employee: seeded, leaveYear: 2027, asOf: "2027-06-30", entries: [], carriedInDays: -11,
    });
    expect(b.annual.carriedIn).toBe(-11);
    expect(b.annual.balance).toBe(19);
  });

  it("a grant beats the seed even in the seed year", () => {
    const b = computeLeaveBalance({
      employee: seeded, leaveYear: 2026, asOf: "2026-12-31", entries: [], carriedInDays: 7,
    });
    expect(b.annual.carriedIn).toBe(7);
  });

  it("a row with no seed year keeps the old reading, so a typed figure is never ignored", () => {
    const b = computeLeaveBalance({
      employee: { ...seeded, seedLeaveYear: null }, leaveYear: 2027, asOf: "2027-06-30", entries: [],
    });
    expect(b.annual.carriedIn).toBe(4);
  });
});
