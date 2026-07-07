/**
 * Pins the registration money math — shared by the detail-sheet Payment
 * block, the Payment Summary, and (by construction) the quote/invoice
 * PDF. The bank-transfer partial-payment → balance case is the one the
 * organizer specifically called out.
 */
import { describe, it, expect } from "vitest";
import {
  computeRegistrationFinancials,
  readRegistrationBasePrice,
} from "@/lib/registration-financials";

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
