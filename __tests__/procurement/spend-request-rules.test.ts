/**
 * The pure spend-request rules: the currency pair to the reporting figure,
 * the budget check per line (within, over, frozen), what a request lacks
 * before submission, and what a change after approval means.
 */
import { describe, it, expect } from "vitest";
import {
  holdsLineReservation,
  reservedOnLine,
  amendmentEffect,
  budgetAcceptsRequests,
  budgetCheck,
  missingForSubmission,
  resolveRequestToReportingRate,
  toReporting,
} from "@/procurement/lib/spend-request-rules";

describe("resolveRequestToReportingRate", () => {
  it("is 1 for the same currency and the peg ratio for two pegged ones, whatever the caller says", () => {
    expect(resolveRequestToReportingRate("aed", "AED", "0.5")).toMatchObject({ ok: true, source: "same" });
    const r = resolveRequestToReportingRate("USD", "AED", "0.0001");
    expect(r.ok && r.source).toBe("peg");
    expect(r.ok && r.rate.toFixed(4)).toBe("3.6725");
    const s = resolveRequestToReportingRate("AED", "USD", null);
    expect(s.ok && s.rate.toFixed(6)).toBe("0.272294");
  });
  it("takes the caller's positive rate for a floating pair and refuses a missing or non-positive one", () => {
    expect(resolveRequestToReportingRate("EUR", "AED", "4.2")).toMatchObject({ ok: true, source: "caller" });
    expect(resolveRequestToReportingRate("EUR", "AED", null)).toEqual({ ok: false, reason: "missing" });
    expect(resolveRequestToReportingRate("EUR", "AED", "0")).toEqual({ ok: false, reason: "invalid" });
    expect(resolveRequestToReportingRate("INR", "USD", "-1")).toEqual({ ok: false, reason: "invalid" });
  });
  it("bands the caller's rate through the rate it implies to AED, and a pair with no peg through its own rail", () => {
    // Two million euros at 0.001 would read as two thousand dirhams and route to the lowest tier (review H1).
    expect(resolveRequestToReportingRate("EUR", "AED", "0.001")).toEqual({ ok: false, reason: "out-of-band" });
    expect(resolveRequestToReportingRate("EUR", "AED", "9")).toEqual({ ok: false, reason: "out-of-band" });
    // A request in EUR against a USD budget: 1.08 implies 1.08 x 3.6725 = 3.97 to AED, inside the band.
    expect(resolveRequestToReportingRate("EUR", "USD", "1.08")).toMatchObject({ ok: true, source: "caller" });
    expect(resolveRequestToReportingRate("EUR", "USD", "0.001")).toEqual({ ok: false, reason: "out-of-band" });
    // A request in USD against a EUR budget: 0.92 implies 3.6725 / 0.92 = 3.99 to AED.
    expect(resolveRequestToReportingRate("USD", "EUR", "0.92")).toMatchObject({ ok: true, source: "caller" });
    expect(resolveRequestToReportingRate("USD", "EUR", "1000")).toEqual({ ok: false, reason: "out-of-band" });
    // Neither side pegged: the pair's own rail, 0.5 to 2.
    expect(resolveRequestToReportingRate("EUR", "GBP", "0.85")).toMatchObject({ ok: true, source: "caller" });
    expect(resolveRequestToReportingRate("GBP", "EUR", "3")).toEqual({ ok: false, reason: "out-of-band" });
    // A non-positive rate is judged before the band.
    expect(resolveRequestToReportingRate("EUR", "AED", "-4")).toEqual({ ok: false, reason: "invalid" });
  });
  it("toReporting stores at four decimals", () => {
    expect(toReporting("1000", "3.6725").toString()).toBe("3672.5");
    expect(toReporting("100", "0.272294").toFixed(4)).toBe("27.2294");
  });
});

describe("budgetCheck", () => {
  const line = { planned: "10000", committedOpen: "2500", actual: "1000" };
  it("is within budget while the remaining after the request is not negative, inclusive at zero", () => {
    const r = budgetCheck({ budgetStatus: "ACTIVE", line, amountReporting: "6500" });
    expect(r).toMatchObject({ status: "WITHIN_BUDGET", exception: false, reasonRequired: false });
    expect(r.remainingBefore.toString()).toBe("6500");
    expect(r.remainingAfter.toString()).toBe("0");
  });
  it("is over budget the moment the line goes negative, on an active budget without a reason", () => {
    const r = budgetCheck({ budgetStatus: "ACTIVE", line, amountReporting: "6500.01" });
    expect(r).toMatchObject({ status: "OVER_BUDGET", exception: true, reasonRequired: false });
    expect(r.remainingAfter.toString()).toBe("-0.01");
  });
  it("on a frozen budget a request within remaining is ordinary and one over it is the FROZEN exception with a reason", () => {
    expect(budgetCheck({ budgetStatus: "FROZEN", line, amountReporting: "100" })).toMatchObject({ status: "WITHIN_BUDGET", exception: false });
    expect(budgetCheck({ budgetStatus: "FROZEN", line, amountReporting: "7000" })).toMatchObject({ status: "FROZEN", exception: true, reasonRequired: true });
  });
  it("counts only the new money when the request already holds a commitment on the line", () => {
    // committedOpen already carries the 2,500 this request committed; raising it to 8,000 adds 5,500 against 6,500 left.
    const r = budgetCheck({ budgetStatus: "ACTIVE", line, amountReporting: "8000", alreadyCommitted: "2500" });
    expect(r.status).toBe("WITHIN_BUDGET");
    expect(r.remainingAfter.toString()).toBe("1000");
  });
  it("only an active or frozen budget accepts a request", () => {
    for (const s of ["ACTIVE", "FROZEN"]) expect(budgetAcceptsRequests(s)).toBe(true);
    for (const s of ["DRAFT", "UNDER_REVIEW", "APPROVED", "CLOSED", "ARCHIVED", ""]) expect(budgetAcceptsRequests(s)).toBe(false);
  });
});

describe("missingForSubmission", () => {
  it("names each gap in the requester's words and is empty when nothing is missing", () => {
    expect(missingForSubmission({ lineKey: null, supplierId: null, proposedVendorName: null, amount: "0", quotes: [] })).toEqual([
      "a budget line to request against",
      "an amount greater than zero",
      "a supplier, or the name of the vendor you propose",
      "at least one quote",
    ]);
    expect(missingForSubmission({ lineKey: "k1", supplierId: null, proposedVendorName: "Gulf AV", amount: "10", quotes: [{}] })).toEqual([]);
  });
});

describe("amendmentEffect", () => {
  it("classes a rise, a fall and no change, with the delta in the reporting currency", () => {
    expect(amendmentEffect("1000", "1250")).toMatchObject({ direction: "INCREASE" });
    expect(amendmentEffect("1000", "1250").delta.toString()).toBe("250");
    expect(amendmentEffect("1000", "900").delta.toString()).toBe("-100");
    expect(amendmentEffect("1000", "900").direction).toBe("DECREASE");
    expect(amendmentEffect("1000", "1000.0000").direction).toBe("SAME");
  });
});

describe("the line's other open requests (review M3)", () => {
  const line = { planned: "10000", committedOpen: "2500", actual: "1000" };
  it("takes what other open requests ask for off the remaining before this one", () => {
    const r = budgetCheck({ budgetStatus: "ACTIVE", line, amountReporting: "4000", reservedByOthers: "3000" });
    expect(r.remainingBefore.toString()).toBe("3500");
    expect(r).toMatchObject({ status: "OVER_BUDGET", exception: true });
    expect(r.reservedByOthers.toString()).toBe("3000");
    expect(budgetCheck({ budgetStatus: "ACTIVE", line, amountReporting: "4000" }).status).toBe("WITHIN_BUDGET");
  });
  it("counts pending, awaiting-supplier and approved-without-order requests at their own rate, never an ordered one or one without a rate", () => {
    const rows = [
      { status: "PENDING_APPROVAL", linkedCommitmentId: null, amount: "1000", fxRateToReporting: "3.6725" },
      { status: "AWAITING_SUPPLIER", linkedCommitmentId: null, amount: "500", fxRateToReporting: "1" },
      { status: "APPROVED", linkedCommitmentId: null, amount: "200", fxRateToReporting: "1" },
      { status: "APPROVED", linkedCommitmentId: "c1", amount: "9999", fxRateToReporting: "1" },
      { status: "CONVERTED", linkedCommitmentId: "c2", amount: "9999", fxRateToReporting: "1" },
      { status: "PENDING_APPROVAL", linkedCommitmentId: null, amount: "9999", fxRateToReporting: null },
    ];
    expect(reservedOnLine(rows).toString()).toBe("4372.5");
    expect(holdsLineReservation({ status: "APPROVED", linkedCommitmentId: "c1" })).toBe(false);
    expect(holdsLineReservation({ status: "AWAITING_SUPPLIER", linkedCommitmentId: null })).toBe(true);
  });
});
