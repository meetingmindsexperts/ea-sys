import { describe, it, expect } from "vitest";

/**
 * Pure logic tests for promo code discount calculations.
 * No mocking needed — tests the math that underpins the promo system.
 */

// ── Replicate the calculation logic from register route + invoice-service ──

function calculateDiscount(
  discountType: "PERCENTAGE" | "FIXED_AMOUNT",
  discountValue: number,
  originalPrice: number,
): { discountAmount: number; finalPrice: number } {
  let discountAmount: number;
  if (discountType === "PERCENTAGE") {
    discountAmount = originalPrice * discountValue / 100;
  } else {
    discountAmount = Math.min(discountValue, originalPrice);
  }
  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalPrice = Math.max(0, originalPrice - discountAmount);
  return { discountAmount, finalPrice };
}

function calculateInvoicePricing(
  originalPrice: number,
  discountAmount: number,
  taxRate: number | null,
) {
  const discountedPrice = Math.max(0, originalPrice - discountAmount);
  const taxAmount = taxRate ? discountedPrice * (taxRate / 100) : 0;
  const total = discountedPrice + taxAmount;
  return { discountedPrice, taxAmount, total };
}

// ── Discount Calculation Tests ──────────────────────────────────────────────

describe("Promo Code Discount Calculation", () => {
  describe("PERCENTAGE discount", () => {
    it("calculates 20% off $500", () => {
      const result = calculateDiscount("PERCENTAGE", 20, 500);
      expect(result.discountAmount).toBe(100);
      expect(result.finalPrice).toBe(400);
    });

    it("calculates 100% off (free ticket)", () => {
      const result = calculateDiscount("PERCENTAGE", 100, 250);
      expect(result.discountAmount).toBe(250);
      expect(result.finalPrice).toBe(0);
    });

    it("calculates 50% off $99.99", () => {
      const result = calculateDiscount("PERCENTAGE", 50, 99.99);
      expect(result.discountAmount).toBe(50);
      expect(result.finalPrice).toBeCloseTo(49.99, 2);
    });

    it("calculates 10% off a small amount ($1.50)", () => {
      const result = calculateDiscount("PERCENTAGE", 10, 1.5);
      expect(result.discountAmount).toBe(0.15);
      expect(result.finalPrice).toBe(1.35);
    });

    it("handles 0% discount", () => {
      const result = calculateDiscount("PERCENTAGE", 0, 500);
      expect(result.discountAmount).toBe(0);
      expect(result.finalPrice).toBe(500);
    });

    it("rounds to 2 decimal places (33.33% of $100)", () => {
      const result = calculateDiscount("PERCENTAGE", 33.33, 100);
      expect(result.discountAmount).toBe(33.33);
      expect(result.finalPrice).toBe(66.67);
    });

    it("rounds correctly for repeating decimals (1/3 of $10)", () => {
      const result = calculateDiscount("PERCENTAGE", 33.333333, 10);
      // 10 * 33.333333 / 100 = 3.3333333 → rounded to 3.33
      expect(result.discountAmount).toBe(3.33);
      expect(result.finalPrice).toBe(6.67);
    });
  });

  describe("FIXED_AMOUNT discount", () => {
    it("calculates $50 off $500", () => {
      const result = calculateDiscount("FIXED_AMOUNT", 50, 500);
      expect(result.discountAmount).toBe(50);
      expect(result.finalPrice).toBe(450);
    });

    it("caps discount at original price ($100 off $30 ticket)", () => {
      const result = calculateDiscount("FIXED_AMOUNT", 100, 30);
      expect(result.discountAmount).toBe(30);
      expect(result.finalPrice).toBe(0);
    });

    it("discount equals price exactly", () => {
      const result = calculateDiscount("FIXED_AMOUNT", 250, 250);
      expect(result.discountAmount).toBe(250);
      expect(result.finalPrice).toBe(0);
    });

    it("handles very small discount ($0.01 off)", () => {
      const result = calculateDiscount("FIXED_AMOUNT", 0.01, 100);
      expect(result.discountAmount).toBe(0.01);
      expect(result.finalPrice).toBe(99.99);
    });
  });

  describe("edge cases", () => {
    it("discount on free ticket is zero", () => {
      const result = calculateDiscount("PERCENTAGE", 50, 0);
      expect(result.discountAmount).toBe(0);
      expect(result.finalPrice).toBe(0);
    });

    it("final price is never negative", () => {
      const result = calculateDiscount("FIXED_AMOUNT", 999, 100);
      expect(result.finalPrice).toBe(0);
      expect(result.finalPrice).toBeGreaterThanOrEqual(0);
    });
  });
});

// ── Invoice Pricing with Discount ───────────────────────────────────────────

describe("Invoice Pricing with Discount", () => {
  it("tax is calculated on discounted price, not original", () => {
    // $500 ticket, $100 discount, 5% tax
    const result = calculateInvoicePricing(500, 100, 5);
    expect(result.discountedPrice).toBe(400);
    expect(result.taxAmount).toBe(20); // 5% of 400, NOT 5% of 500
    expect(result.total).toBe(420);
  });

  it("no tax when taxRate is null", () => {
    const result = calculateInvoicePricing(500, 100, null);
    expect(result.discountedPrice).toBe(400);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(400);
  });

  it("no tax when taxRate is 0", () => {
    const result = calculateInvoicePricing(500, 100, 0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(400);
  });

  it("full discount with tax — total is zero", () => {
    const result = calculateInvoicePricing(100, 100, 10);
    expect(result.discountedPrice).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(0);
  });

  it("no discount — behaves like original pricing", () => {
    const result = calculateInvoicePricing(500, 0, 5);
    expect(result.discountedPrice).toBe(500);
    expect(result.taxAmount).toBe(25);
    expect(result.total).toBe(525);
  });

  it("high tax rate (20%) with discount", () => {
    // $1000 ticket, $200 discount, 20% VAT
    const result = calculateInvoicePricing(1000, 200, 20);
    expect(result.discountedPrice).toBe(800);
    expect(result.taxAmount).toBe(160);
    expect(result.total).toBe(960);
  });
});

// ── Promo Code Validation Logic ─────────────────────────────────────────────

describe("Promo Code Validation Logic", () => {
  const now = new Date("2026-04-08T12:00:00Z");

  function isDateValid(validFrom: Date | null, validUntil: Date | null, checkTime: Date): boolean {
    if (validFrom && checkTime < validFrom) return false;
    if (validUntil && checkTime > validUntil) return false;
    return true;
  }

  function isUnderMaxUses(usedCount: number, maxUses: number | null): boolean {
    if (maxUses === null) return true;
    return usedCount < maxUses;
  }

  function isTicketTypeApplicable(
    promoTicketTypeIds: string[],
    selectedTicketTypeId: string,
  ): boolean {
    if (promoTicketTypeIds.length === 0) return true;
    return promoTicketTypeIds.includes(selectedTicketTypeId);
  }

  describe("date range validation", () => {
    it("valid when no date constraints", () => {
      expect(isDateValid(null, null, now)).toBe(true);
    });

    it("valid when current time is within range", () => {
      const from = new Date("2026-04-01T00:00:00Z");
      const until = new Date("2026-04-30T23:59:59Z");
      expect(isDateValid(from, until, now)).toBe(true);
    });

    it("invalid when before validFrom", () => {
      const from = new Date("2026-04-10T00:00:00Z");
      expect(isDateValid(from, null, now)).toBe(false);
    });

    it("invalid when after validUntil", () => {
      const until = new Date("2026-04-07T00:00:00Z");
      expect(isDateValid(null, until, now)).toBe(false);
    });

    it("valid when only validFrom is set and passed", () => {
      const from = new Date("2026-04-01T00:00:00Z");
      expect(isDateValid(from, null, now)).toBe(true);
    });

    it("valid when only validUntil is set and not passed", () => {
      const until = new Date("2026-12-31T23:59:59Z");
      expect(isDateValid(null, until, now)).toBe(true);
    });
  });

  describe("max uses validation", () => {
    it("unlimited uses when maxUses is null", () => {
      expect(isUnderMaxUses(9999, null)).toBe(true);
    });

    it("allowed when under limit", () => {
      expect(isUnderMaxUses(3, 10)).toBe(true);
    });

    it("blocked when at limit", () => {
      expect(isUnderMaxUses(10, 10)).toBe(false);
    });

    it("blocked when over limit (safety)", () => {
      expect(isUnderMaxUses(11, 10)).toBe(false);
    });

    it("allowed when zero uses on limit of 1", () => {
      expect(isUnderMaxUses(0, 1)).toBe(true);
    });
  });

  describe("ticket type applicability", () => {
    it("applies to all when no restrictions", () => {
      expect(isTicketTypeApplicable([], "any-ticket")).toBe(true);
    });

    it("applies when ticket type is in the list", () => {
      expect(isTicketTypeApplicable(["tt-1", "tt-2"], "tt-1")).toBe(true);
    });

    it("rejects when ticket type is not in the list", () => {
      expect(isTicketTypeApplicable(["tt-1", "tt-2"], "tt-3")).toBe(false);
    });

    it("single restriction matches", () => {
      expect(isTicketTypeApplicable(["tt-vip"], "tt-vip")).toBe(true);
    });

    it("single restriction rejects", () => {
      expect(isTicketTypeApplicable(["tt-vip"], "tt-standard")).toBe(false);
    });
  });
});
