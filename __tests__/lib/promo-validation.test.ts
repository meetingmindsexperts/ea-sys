/**
 * Shared promo rules. These matter because three surfaces ask "is this code
 * usable?" and a disagreement between them means a code that works on one
 * form and not another.
 */
import { describe, it, expect } from "vitest";
import {
  checkPromoUsable, promoDiscountFor, promoEligibleBase,
} from "@/lib/promo-validation";

const NOW = new Date("2026-08-07T10:00:00Z");

function promo(over: Partial<Parameters<typeof checkPromoUsable>[0]["promo"] & object> = {}) {
  return {
    isActive: true,
    validFrom: null,
    validUntil: null,
    maxUses: null,
    usedCount: 0,
    maxUsesPerEmail: null,
    applicableTicketTypeIds: [] as string[],
    discountType: "PERCENTAGE" as const,
    discountValue: 10,
    ...over,
  };
}

const check = (p: ReturnType<typeof promo> | null, extra = {}) =>
  checkPromoUsable({ promo: p, now: NOW, ticketTypeIds: ["tt1"], ...extra });

describe("checkPromoUsable", () => {
  it("accepts a plain live code", () => {
    expect(check(promo())).toBeNull();
  });

  it("rejects unknown, inactive, not-yet-valid and expired codes distinctly", () => {
    expect(check(null)?.code).toBe("NOT_FOUND");
    expect(check(promo({ isActive: false }))?.code).toBe("INACTIVE");
    expect(check(promo({ validFrom: new Date("2026-09-01") }))?.code).toBe("NOT_YET_VALID");
    expect(check(promo({ validUntil: new Date("2026-08-01") }))?.code).toBe("EXPIRED");
  });

  it("enforces the overall usage cap at the boundary", () => {
    expect(check(promo({ maxUses: 10, usedCount: 9 }))).toBeNull();
    expect(check(promo({ maxUses: 10, usedCount: 10 }))?.code).toBe("MAX_USES_REACHED");
  });

  it("enforces the per-email cap only when the caller supplies a count", () => {
    // The group path may not track per-email use the same way; absent count
    // must not silently pass a cap the caller meant to enforce, nor invent one.
    expect(check(promo({ maxUsesPerEmail: 1 }))).toBeNull();
    expect(check(promo({ maxUsesPerEmail: 1 }), { emailUses: 1 })?.code).toBe(
      "MAX_USES_PER_EMAIL_REACHED",
    );
  });

  it("a restricted code is usable if ANY selected type qualifies", () => {
    const p = promo({ applicableTicketTypeIds: ["ttA"] });
    expect(check(p, { ticketTypeIds: ["ttA", "ttB"] })).toBeNull();
    expect(check(p, { ticketTypeIds: ["ttB"] })?.code).toBe("NOT_APPLICABLE");
  });
});

describe("promoDiscountFor", () => {
  it("takes a percentage of the base", () => {
    expect(promoDiscountFor({ discountType: "PERCENTAGE", discountValue: 20 }, 1000)).toBe(200);
  });

  it("a fixed amount never exceeds what is being discounted", () => {
    // Otherwise a €500 code on a €100 booking becomes a €400 credit.
    expect(promoDiscountFor({ discountType: "FIXED_AMOUNT", discountValue: 500 }, 100)).toBe(100);
  });

  it("bad admin data can never produce a surcharge", () => {
    expect(promoDiscountFor({ discountType: "PERCENTAGE", discountValue: 150 }, 100)).toBe(100);
    expect(promoDiscountFor({ discountType: "PERCENTAGE", discountValue: -20 }, 100)).toBe(0);
    expect(promoDiscountFor({ discountType: "FIXED_AMOUNT", discountValue: -50 }, 100)).toBe(0);
  });

  it("is zero against a zero base", () => {
    expect(promoDiscountFor({ discountType: "PERCENTAGE", discountValue: 20 }, 0)).toBe(0);
  });
});

describe("promoEligibleBase", () => {
  const members = [
    { ticketTypeId: "phys", price: 250 },
    { ticketTypeId: "phys", price: 250 },
    { ticketTypeId: "nurse", price: 100 },
  ];

  it("an unrestricted code discounts the whole subtotal", () => {
    expect(promoEligibleBase([], members)).toBe(600);
  });

  it("a restricted code discounts only the members it applies to", () => {
    // "Physician 20% off" on a mixed group must not take 20% off the nurse.
    expect(promoEligibleBase(["phys"], members)).toBe(500);
  });

  it("is zero when no member qualifies", () => {
    expect(promoEligibleBase(["other"], members)).toBe(0);
  });
});
