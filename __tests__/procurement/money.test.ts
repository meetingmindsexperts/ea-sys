/**
 * Every rule in spec §7 and §6a as a table of cases. These are the numbers
 * finance signs off, so each case names the rule it pins.
 */
import { describe, it, expect } from "vitest";
import DecimalBase from "decimal.js";
import { Prisma } from "@prisma/client";
import type { Decimal } from "@/procurement/lib/money";
import {
  budgetTotals,
  contingencyAmount,
  displayTotal,
  forecastDefault,
  forecastFor,
  isAtRisk,
  lineTotals,
  money,
  reallocationCap,
  reallocationExceedsCap,
  remaining,
  storedString,
  toAed,
  toDisplay,
  toStored,
  varianceRequiresNote,
} from "@/procurement/lib/money";

const s = (d: Decimal) => d.toString();

describe("money: storage and display rounding", () => {
  it("stores 4 dp and displays 2 dp with banker's rounding, never round-half-up", () => {
    expect(s(toStored("1.23455"))).toBe("1.2346");
    expect(s(toStored("1.23445"))).toBe("1.2344");
    expect(s(toDisplay("2.345"))).toBe("2.34");
    expect(s(toDisplay("2.355"))).toBe("2.36");
    expect(storedString(7)).toBe("7.0000");
  });
  it("resolves sum-vs-display drift at the TOTAL, never by adjusting lines", () => {
    const lines = ["10.0050", "10.0050", "10.0050"];
    expect(s(displayTotal(lines))).toBe("30.02");
    expect(lines.map((l) => toDisplay(l).toFixed(2))).toEqual(["10.00", "10.00", "10.00"]);
  });
  it("refuses a non-finite amount and reads null as zero", () => {
    expect(() => money(Number.NaN)).toThrow();
    expect(() => money("abc")).toThrow(/not a decimal amount/);
    expect(s(money(null))).toBe("0");
  });
  it("accepts a Prisma Decimal row value and the library's own singleton (review H1)", () => {
    const fromRow = new Prisma.Decimal("1234.5678");
    expect(s(money(fromRow))).toBe("1234.5678");
    expect(s(remaining({ planned: new Prisma.Decimal("1000"), committedOpen: new Prisma.Decimal("300.25"), actual: new Prisma.Decimal("0") }))).toBe("699.75");
    expect(s(money(new DecimalBase("2.5")))).toBe("2.5");
  });
  it("does not mutate the shared decimal.js configuration (review L1)", () => {
    expect(DecimalBase.rounding).toBe(DecimalBase.ROUND_HALF_UP);
  });
});

describe("money: line totals", () => {
  it("qty × unit cost at the snapshot rate, ex-VAT, tax beside it", () => {
    const t = lineTotals({ qty: 3, unitCost: "1250.50", fxRateToReporting: "3.6725", taxRatePercent: 5 });
    expect(s(t.plannedTransaction)).toBe("3751.5");
    expect(s(t.planned)).toBe("13777.3838");
    expect(s(t.taxAmountPlanned)).toBe("688.8692");
  });
  it("rate 1 when the currencies match; no tax for out-of-scope lines", () => {
    const t = lineTotals({ qty: 2, unitCost: 100, fxRateToReporting: 1, taxRatePercent: null });
    expect(s(t.planned)).toBe("200");
    expect(s(t.taxAmountPlanned)).toBe("0");
  });
  it("rejects a rate of zero or below and a negative planned figure (spec §7.3, §7.6)", () => {
    expect(() => lineTotals({ qty: 1, unitCost: 1, fxRateToReporting: 0 })).toThrow(/rate/);
    expect(() => lineTotals({ qty: 1, unitCost: 1, fxRateToReporting: -1 })).toThrow(/rate/);
    expect(() => lineTotals({ qty: -1, unitCost: 1, fxRateToReporting: 1 })).toThrow(/negative/);
  });
});

describe("money: remaining, forecast, at-risk (spec §7.7, §6a)", () => {
  it("remaining = planned − committedOpen − actual and may go negative", () => {
    expect(s(remaining({ planned: 1000, committedOpen: 300, actual: 500 }))).toBe("200");
    expect(s(remaining({ planned: 1000, committedOpen: 700, actual: 500 }))).toBe("-200");
  });
  it("forecast defaults to the larger of planned and committedOpen + actual", () => {
    expect(s(forecastDefault({ planned: 1000, committedOpen: 300, actual: 500 }))).toBe("1000");
    expect(s(forecastDefault({ planned: 1000, committedOpen: 700, actual: 500 }))).toBe("1200");
    expect(s(forecastFor({ planned: 1000, committedOpen: 0, actual: 0, forecastFinalAmount: "1500.5" }))).toBe("1500.5");
    expect(s(forecastFor({ planned: 1000, committedOpen: 0, actual: 0, forecastFinalAmount: null }))).toBe("1000");
  });
  it("contingency is a percent of the total that excludes it, and at-risk compares against both", () => {
    expect(s(contingencyAmount(10000, 10))).toBe("1000");
    expect(isAtRisk(11000, 10000, 1000)).toBe(false);
    expect(isAtRisk("11000.0001", 10000, 1000)).toBe(true);
  });
  it("rolls lines up: deleted lines count for nothing, the contingency line is outside plannedExpenseTotal but inside the forecast", () => {
    const t = budgetTotals(
      [
        { planned: 1000, taxAmountPlanned: 50, committedOpen: 0, actual: 0, isContingency: false },
        { planned: 2000, taxAmountPlanned: 100, committedOpen: 2500, actual: 0, isContingency: false },
        { planned: 9999, taxAmountPlanned: 1, committedOpen: 0, actual: 0, isContingency: false, deletedAt: new Date() },
        { planned: 300, taxAmountPlanned: 0, committedOpen: 0, actual: 0, isContingency: true },
      ],
      10,
    );
    expect(s(t.plannedExpenseTotal)).toBe("3000");
    expect(s(t.taxTotalPlanned)).toBe("150");
    expect(s(t.contingencyAmount)).toBe("300");
    expect(s(t.forecastTotal)).toBe("3800");
    expect(t.atRisk).toBe(true);
  });
});

describe("money: reallocation authority (spec §6a, §14 Q2)", () => {
  it("caps the owner at 10% of the line's approved planned amount per version, inclusive", () => {
    expect(s(reallocationCap(5000))).toBe("500");
    expect(reallocationExceedsCap({ approvedPlanned: 5000, movedSoFarThisVersion: 0, amount: 500 })).toBe(false);
    expect(reallocationExceedsCap({ approvedPlanned: 5000, movedSoFarThisVersion: 0, amount: "500.01" })).toBe(true);
    expect(reallocationExceedsCap({ approvedPlanned: 5000, movedSoFarThisVersion: 400, amount: 100 })).toBe(false);
    expect(reallocationExceedsCap({ approvedPlanned: 5000, movedSoFarThisVersion: 400, amount: 101 })).toBe(true);
  });
  it("a reallocation moves a positive amount", () => {
    expect(() => reallocationExceedsCap({ approvedPlanned: 5000, movedSoFarThisVersion: 0, amount: 0 })).toThrow();
  });
});

describe("money: close-out variance and AED conversion", () => {
  it("needs a note past 10% or the floor, whichever is larger (spec §14 Q13)", () => {
    expect(varianceRequiresNote({ planned: 100000, actual: 109000, floorInReporting: 5000 })).toBe(false);
    expect(varianceRequiresNote({ planned: 100000, actual: 110001, floorInReporting: 5000 })).toBe(true);
    expect(varianceRequiresNote({ planned: 10000, actual: 14000, floorInReporting: 5000 })).toBe(false);
    expect(varianceRequiresNote({ planned: 10000, actual: 15001, floorInReporting: 5000 })).toBe(true);
    expect(varianceRequiresNote({ planned: 10000, actual: 4999, floorInReporting: 5000 })).toBe(true);
  });
  it("converts to AED at the snapshot rate for the ceiling check", () => {
    expect(s(toAed(1000, "3.6725"))).toBe("3672.5");
    expect(() => toAed(1000, 0)).toThrow(/rate/);
  });
});
