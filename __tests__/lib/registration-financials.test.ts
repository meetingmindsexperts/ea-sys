/**
 * Pins the registration money math — shared by the detail-sheet Payment
 * block, the Payment Summary, and (by construction) the quote/invoice
 * PDF. The bank-transfer partial-payment → balance case is the one the
 * organizer specifically called out.
 */
import { describe, it, expect } from "vitest";
import {
  computeCancelledCreditState,
  computeRegistrationFinancials,
  readRegistrationBasePrice,
  registrationChargesNothing,
} from "@/lib/registration-financials";

describe("registrationChargesNothing: a zero price, or a code that takes the whole of it", () => {
  it("a zero price charges nothing, a priced one does", () => {
    expect(registrationChargesNothing({ originalPrice: 0, ticketType: { price: 0 } })).toBe(true);
    expect(registrationChargesNothing({ ticketType: { price: 0 } })).toBe(true);
    expect(registrationChargesNothing({ originalPrice: 200, ticketType: { price: 0 } })).toBe(false);
    // The stamping-gap guard still wins: 0 stamped beside a priced rate owes the rate.
    expect(registrationChargesNothing({ originalPrice: 0, pricingTier: { price: 100 }, ticketType: { price: 0 } })).toBe(false);
  });

  it("a code that covers the whole price charges nothing (the production rows: 200.00 less 200.00)", () => {
    expect(registrationChargesNothing({ originalPrice: "200.00", discountAmount: "200.00", ticketType: { price: 0 } })).toBe(true);
    expect(registrationChargesNothing({ originalPrice: 350, discountAmount: 350 })).toBe(true);
    // More than the price (a fixed code larger than the fee) is still nothing owed.
    expect(registrationChargesNothing({ originalPrice: 100, discountAmount: 150 })).toBe(true);
  });

  it("a partial code still owes, down to the last cent", () => {
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: 199.99 })).toBe(false);
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: 100 })).toBe(false);
  });

  it("an absent, zero or unreadable discount changes nothing (a payload with money stripped never admits)", () => {
    expect(registrationChargesNothing({ originalPrice: 200 })).toBe(false);
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: null })).toBe(false);
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: 0 })).toBe(false);
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: "abc" })).toBe(false);
    expect(registrationChargesNothing({ originalPrice: 200, discountAmount: -200 })).toBe(false);
  });
});

describe("computeRegistrationFinancials", () => {
  it("subtotal + VAT, nothing paid → full balance", () => {
    const f = computeRegistrationFinancials({
      subtotal: 1000,
      taxRate: 5,
      taxLabel: "VAT",
      currency: "AED",
    });
    expect(f.subtotal).toBe(1000);
    expect(f.taxAmount).toBe(50);
    expect(f.total).toBe(1050);
    expect(f.totalPaid).toBe(0);
    expect(f.balanceDue).toBe(1050);
    expect(f.isPaidInFull).toBe(false);
    expect(f.hasOutstandingBalance).toBe(true);
    expect(f.currency).toBe("AED");
    expect(f.taxLabel).toBe("VAT");
  });

  it("zero-tax event → no tax line, total = subtotal", () => {
    const f = computeRegistrationFinancials({ subtotal: 500, taxRate: 0 });
    expect(f.taxAmount).toBe(0);
    expect(f.total).toBe(500);
    expect(f.taxLabel).toBe("VAT"); // label still defaulted; UI hides line when rate 0
  });

  it("null taxRate is treated as no tax", () => {
    const f = computeRegistrationFinancials({ subtotal: 300, taxRate: null });
    expect(f.taxAmount).toBe(0);
    expect(f.total).toBe(300);
  });

  it("promo discount reduces the taxable base before VAT", () => {
    // 1000 − 200 = 800 taxable; 5% = 40; total 840
    const f = computeRegistrationFinancials({
      subtotal: 1000,
      discount: 200,
      taxRate: 5,
    });
    expect(f.taxableBase).toBe(800);
    expect(f.taxAmount).toBe(40);
    expect(f.total).toBe(840);
  });

  it("bank-transfer partial payment leaves a balance (the organizer's case)", () => {
    // Total 1050, finance recorded a 600 bank-transfer → 450 still owed.
    const f = computeRegistrationFinancials({
      subtotal: 1000,
      taxRate: 5,
      totalPaid: 600,
    });
    expect(f.total).toBe(1050);
    expect(f.totalPaid).toBe(600);
    expect(f.balanceDue).toBe(450);
    expect(f.isPaidInFull).toBe(false);
  });

  it("paid in full → zero balance, isPaidInFull true", () => {
    const f = computeRegistrationFinancials({
      subtotal: 1000,
      taxRate: 5,
      totalPaid: 1050,
    });
    expect(f.balanceDue).toBe(0);
    expect(f.isPaidInFull).toBe(true);
    expect(f.hasOutstandingBalance).toBe(false);
  });

  it("over-payment never produces a negative balance", () => {
    const f = computeRegistrationFinancials({
      subtotal: 100,
      taxRate: 0,
      totalPaid: 250,
    });
    expect(f.balanceDue).toBe(0);
    expect(f.isPaidInFull).toBe(true);
  });

  it("rounding: 1-cent float drift across partials still reads paid-in-full", () => {
    const f = computeRegistrationFinancials({
      subtotal: 33.33,
      taxRate: 5,
      totalPaid: 34.997, // ≈ 33.33 + 1.67
    });
    expect(f.isPaidInFull).toBe(true);
    expect(f.balanceDue).toBe(0);
  });

  it("misconfigured discount > subtotal can't make taxable base negative", () => {
    const f = computeRegistrationFinancials({
      subtotal: 100,
      discount: 500,
      taxRate: 5,
    });
    expect(f.taxableBase).toBe(0);
    expect(f.taxAmount).toBe(0);
    expect(f.total).toBe(0);
  });

  it("free / no-ticket registration → all zeros, paid in full, no outstanding", () => {
    const f = computeRegistrationFinancials({ subtotal: 0 });
    expect(f.total).toBe(0);
    expect(f.isPaidInFull).toBe(true);
    expect(f.hasOutstandingBalance).toBe(false);
  });
});

describe("readRegistrationBasePrice", () => {
  it("prefers a stamped originalPrice", () => {
    expect(
      readRegistrationBasePrice({ originalPrice: 300, pricingTier: { price: 250 }, ticketType: { price: 100 } }),
    ).toBe(300);
  });

  it("falls back to the tier price when originalPrice is null", () => {
    expect(
      readRegistrationBasePrice({ originalPrice: null, pricingTier: { price: 250 }, ticketType: { price: 100 } }),
    ).toBe(250);
  });

  it("falls back to the ticket price when no originalPrice and no tier", () => {
    expect(readRegistrationBasePrice({ originalPrice: null, pricingTier: null, ticketType: { price: 100 } })).toBe(100);
  });

  // The reported bug: a stamped originalPrice of exactly 0 alongside a priced
  // tier used to resolve to 0 (`0 ?? 250` → 0) → "no price set yet" while the
  // Early Bird tier is clearly 250.
  it("stamping gap: originalPrice 0 + priced tier → prefers the tier price", () => {
    expect(readRegistrationBasePrice({ originalPrice: 0, pricingTier: { price: 250 }, ticketType: { price: 0 } })).toBe(250);
  });

  it("stamping gap: originalPrice '0' string + priced tier → prefers the tier price", () => {
    expect(readRegistrationBasePrice({ originalPrice: "0", pricingTier: { price: 250 } })).toBe(250);
  });

  it("genuine free comp: originalPrice 0, no priced tier → stays 0", () => {
    expect(readRegistrationBasePrice({ originalPrice: 0, pricingTier: null, ticketType: { price: 100 } })).toBe(0);
  });

  it("free tier (price 0) with originalPrice 0 → stays 0", () => {
    expect(readRegistrationBasePrice({ originalPrice: 0, pricingTier: { price: 0 } })).toBe(0);
  });

  it("nothing set → 0", () => {
    expect(readRegistrationBasePrice({})).toBe(0);
  });
});

/**
 * The organizer-reported gap (July 20, 2026): a PAID registration cancelled
 * WITHOUT a refund kept showing a positive "Collected" figure and Amount Due
 * 0, with no prompt — the retained money must render as a NEGATIVE balance
 * and flag "needs credit note" until credit notes cover the collected total.
 */
describe("computeCancelledCreditState", () => {
  it("cancelled + PAID with no credit note → retained shown, needsCreditNote", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: 525,
    });
    expect(s).toEqual({ retained: 525, uncredited: 525, needsCreditNote: true });
  });

  it("credit note covering the collected total clears the prompt (money still retained)", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: 525,
      creditedAmount: 525,
    });
    expect(s.needsCreditNote).toBe(false);
    // Owner decision: the CN documents the reversal; the refund stays
    // optional, so the retained figure keeps showing until refunded.
    expect(s.retained).toBe(525);
    expect(s.uncredited).toBe(0);
  });

  it("partial credit note → still prompts for the uncovered remainder", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: 525,
      creditedAmount: 200,
    });
    expect(s.needsCreditNote).toBe(true);
    expect(s.uncredited).toBe(325);
  });

  it("partial refund shrinks the retained balance but not the CN requirement", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: 525,
      refundedAmount: 200,
      creditedAmount: 200,
    });
    expect(s.retained).toBe(325);
    expect(s.uncredited).toBe(325);
    expect(s.needsCreditNote).toBe(true);
  });

  it("fully refunded (paymentStatus REFUNDED) never prompts", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "REFUNDED",
      paidTotal: 525,
      refundedAmount: 525,
      creditedAmount: 525,
    });
    expect(s.retained).toBe(0);
    expect(s.needsCreditNote).toBe(false);
  });

  // Regression (July 20, 2026): a cancelled UNPAID/PENDING reg — nothing ever
  // collected — must NOT show a negative "credit owed" balance. The detail
  // route falls back paidTotal → the computed total when there are no settled
  // Payment rows (correct only for a hand-flipped PAID reg); for a Pending reg
  // that fallback wrongly produced retained = full total → −$157.50 on screen.
  it("cancelled PENDING with a paidTotal fallback → zero retained, no prompt", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PENDING",
      paidTotal: 157.5, // the computed-total fallback, NOT real money
    });
    expect(s).toEqual({ retained: 0, uncredited: 0, needsCreditNote: false });
  });

  it("cancelled UNPAID / UNASSIGNED never shows retained money", () => {
    for (const status of ["UNPAID", "UNASSIGNED", "COMPLIMENTARY", "INCLUSIVE"]) {
      const s = computeCancelledCreditState({
        isCancelled: true,
        paymentStatus: status,
        paidTotal: 500,
      });
      expect(s.retained).toBe(0);
      expect(s.needsCreditNote).toBe(false);
    }
  });

  it("not cancelled → never prompts even with uncredited money", () => {
    const s = computeCancelledCreditState({
      isCancelled: false,
      paymentStatus: "PAID",
      paidTotal: 525,
    });
    expect(s.needsCreditNote).toBe(false);
  });

  it("cancelled unpaid (nothing collected) → no prompt, zero balances", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "UNPAID",
      paidTotal: 0,
    });
    expect(s).toEqual({ retained: 0, uncredited: 0, needsCreditNote: false });
  });

  it("1-cent rounding residue does not prompt (mirrors isPaidInFull tolerance)", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: 100.0,
      creditedAmount: 99.995,
    });
    expect(s.needsCreditNote).toBe(false);
  });

  it("clamps garbage inputs (negative / NaN) to zero", () => {
    const s = computeCancelledCreditState({
      isCancelled: true,
      paymentStatus: "PAID",
      paidTotal: Number.NaN,
      refundedAmount: -50,
      creditedAmount: -10,
    });
    expect(s).toEqual({ retained: 0, uncredited: 0, needsCreditNote: false });
  });
});
