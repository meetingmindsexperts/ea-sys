/**
 * The promo rules shared by the public form, the desk walk-in and the desk's
 * code check (src/lib/promo-redeem.ts). The order is the public route's, so a
 * refusal names the same reason on every door.
 */
import { describe, it, expect } from "vitest";
import { promoDiscount, promoRefusal, promoSponsorCovers, type RedeemablePromo } from "@/lib/promo-redeem";

const NOW = new Date("2026-10-29T10:00:00Z");
const base: RedeemablePromo = {
  isActive: true,
  validFrom: null,
  validUntil: null,
  ticketTypes: [],
  sponsorId: null,
  sponsorCoversFee: false,
  discountType: "PERCENTAGE",
  discountValue: 20,
};
const opts = { now: NOW, ticketTypeId: "tt1" };

describe("promoRefusal", () => {
  it("accepts an active, in-date code with no type restriction", () => {
    expect(promoRefusal(base, opts)).toBeNull();
  });
  it("refuses a missing, inactive, not-yet-valid or expired code as invalid", () => {
    expect(promoRefusal(null, opts)).toBe("INVALID_PROMO_CODE");
    expect(promoRefusal({ ...base, isActive: false }, opts)).toBe("INVALID_PROMO_CODE");
    expect(promoRefusal({ ...base, validFrom: "2026-11-01T00:00:00Z" }, opts)).toBe("INVALID_PROMO_CODE");
    expect(promoRefusal({ ...base, validUntil: "2026-10-01T00:00:00Z" }, opts)).toBe("INVALID_PROMO_CODE");
  });
  it("refuses a code restricted to other types", () => {
    expect(promoRefusal({ ...base, ticketTypes: [{ ticketTypeId: "tt2" }] }, opts)).toBe("PROMO_CODE_NOT_APPLICABLE");
    expect(promoRefusal({ ...base, ticketTypes: [{ ticketTypeId: "tt1" }] }, opts)).toBeNull();
  });
  it("when a sponsor code is required, refuses a discount code and a sponsor code that does not cover the fee", () => {
    const sponsorOnly = { ...opts, requireSponsorCover: true };
    expect(promoRefusal(base, sponsorOnly)).toBe("PROMO_CODE_NOT_SPONSOR");
    expect(promoRefusal({ ...base, sponsorId: "sp1" }, sponsorOnly)).toBe("PROMO_CODE_NOT_SPONSOR");
    expect(promoRefusal({ ...base, sponsorId: "sp1", sponsorCoversFee: true }, sponsorOnly)).toBeNull();
  });
});

describe("promoDiscount", () => {
  it("takes a percentage or a fixed amount off, rounded to cents", () => {
    expect(promoDiscount(base, 125)).toEqual({ discountAmount: 25, finalPrice: 100 });
    expect(promoDiscount({ discountType: "FIXED_AMOUNT", discountValue: 33.333 }, 100)).toEqual({ discountAmount: 33.33, finalPrice: 66.67 });
  });
  it("never discounts more than the price or adds a surcharge", () => {
    expect(promoDiscount({ discountType: "PERCENTAGE", discountValue: 150 }, 80).finalPrice).toBe(0);
    expect(promoDiscount({ discountType: "FIXED_AMOUNT", discountValue: 500 }, 80)).toEqual({ discountAmount: 80, finalPrice: 0 });
    expect(promoDiscount({ discountType: "PERCENTAGE", discountValue: -10 }, 80).discountAmount).toBe(0);
  });
});

describe("promoSponsorCovers", () => {
  it("only a sponsor-covers code with nothing left to pay", () => {
    const covering = { sponsorId: "sp1", sponsorCoversFee: true };
    expect(promoSponsorCovers(covering, 0)).toBe(true);
    expect(promoSponsorCovers(covering, 10)).toBe(false);
    expect(promoSponsorCovers({ sponsorId: null, sponsorCoversFee: true }, 0)).toBe(false);
  });
});
