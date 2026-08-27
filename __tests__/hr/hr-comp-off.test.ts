import { describe, it, expect } from "vitest";
import { compOffEarnings, countCompOffEarned } from "@/hr/lib/hr-comp-off";

/**
 * Fixtures are the REAL OD days from the v5.1 workbook, so these assert against
 * production data rather than invented cases. 2026-01-17 and 2026-02-14 are
 * Saturdays; 2026-01-18 and 2026-02-15 are the Sundays after them.
 */
describe("comp-off earning: both days of one weekend", () => {
  it("earns one for a Saturday plus Sunday pair", () => {
    expect(countCompOffEarned({ onDutyDates: ["2026-01-17", "2026-01-18"] })).toBe(1);
  });

  /**
   * EMP001 Leena: two OD days, both lone Saturdays a week apart, and the
   * workbook agrees she earned nothing. Half a weekend worked is a weekend not
   * given back.
   */
  it("earns nothing for lone Saturdays", () => {
    expect(
      countCompOffEarned({ onDutyDates: ["2026-06-27", "2026-07-04"] }),
    ).toBe(0);
  });

  /**
   * THE GUARD THAT MATTERS, and the one live divergence from the workbook.
   *
   * EMP002 Nawfer worked Wed 14 and Thu 15 January 2026. The workbook's formula
   * asks only "was yesterday also OD" and credits her a comp-off; the rule
   * (owner, Aug 27 2026) is that only a weekend earns one, so this is zero.
   * Copying the workbook formula would pass every other test in this file.
   */
  it("earns nothing for two consecutive WORKING days marked OD", () => {
    expect(countCompOffEarned({ onDutyDates: ["2026-01-14", "2026-01-15"] })).toBe(0);
  });

  /**
   * The case the owner was actually asked about. Friday is a working day here,
   * so a Fri+Sat+Sun run is still one weekend worked, not two overlapping pairs.
   * The previous-day rule returns 2.
   */
  it("earns one, not two, for Friday plus the whole weekend", () => {
    expect(
      countCompOffEarned({ onDutyDates: ["2026-01-16", "2026-01-17", "2026-01-18"] }),
    ).toBe(1);
  });

  it("earns one per fully-worked weekend, counting each weekend once", () => {
    // EMP005 Dinalyn: two full weekends plus a lone Saturday.
    expect(
      countCompOffEarned({
        onDutyDates: ["2026-01-17", "2026-01-18", "2026-02-14", "2026-02-15", "2026-07-04"],
      }),
    ).toBe(2);
    // EMP006 Vivek: two full weekends among seven OD days.
    expect(
      countCompOffEarned({
        onDutyDates: [
          "2026-01-17", "2026-01-18", "2026-02-07",
          "2026-02-14", "2026-02-15", "2026-06-27", "2026-07-04",
        ],
      }),
    ).toBe(2);
  });

  it("names which weekend earned each day, not just how many", () => {
    expect(
      compOffEarnings({ onDutyDates: ["2026-02-14", "2026-02-15", "2026-01-17", "2026-01-18"] }),
    ).toEqual([
      { from: "2026-01-17", to: "2026-01-18" },
      { from: "2026-02-14", to: "2026-02-15" },
    ]);
  });

  it("ignores duplicate OD dates", () => {
    expect(
      countCompOffEarned({ onDutyDates: ["2026-01-17", "2026-01-17", "2026-01-18"] }),
    ).toBe(1);
  });

  /**
   * A weekend straddling New Year is still one weekend. Comp-off is a running
   * balance rather than an annual one, so nothing here is bounded by the year.
   */
  it("handles a weekend that straddles the year boundary", () => {
    // 2027-01-02 is a Saturday, 2027-01-03 the Sunday after it.
    expect(countCompOffEarned({ onDutyDates: ["2027-01-02", "2027-01-03"] })).toBe(1);
  });

  /**
   * Generalised over the weekend configuration, because some GCC entities run
   * Friday and Saturday. Under that roster the same January dates are a lone
   * Saturday plus an ordinary Sunday, and earn nothing.
   */
  it("follows the org's weekend configuration", () => {
    const friSat = [5, 6];
    expect(
      countCompOffEarned({ onDutyDates: ["2026-01-16", "2026-01-17"], weekendDays: friSat }),
    ).toBe(1);
    expect(
      countCompOffEarned({ onDutyDates: ["2026-01-17", "2026-01-18"], weekendDays: friSat }),
    ).toBe(0);
  });

  it("earns nothing when the org has no weekend configured", () => {
    expect(
      countCompOffEarned({ onDutyDates: ["2026-01-17", "2026-01-18"], weekendDays: [] }),
    ).toBe(0);
  });
});
