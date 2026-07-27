/**
 * "Whatever tier is open when they complete" — the rule that prices a
 * registration whose type is chosen on the completion form (owner decision,
 * July 27 2026). Everywhere else the tier comes from the shared Early-Bird /
 * Standard / Onsite link; this flow has no link, so the rule has to be pinned.
 */
import { describe, it, expect } from "vitest";
import { pickCurrentPricingTier, isTierOnSale, type PricingTierCandidate } from "@/lib/current-pricing-tier";

const NOW = new Date("2026-07-27T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function tier(over: Partial<PricingTierCandidate> = {}): PricingTierCandidate {
  return {
    id: "t1",
    name: "Standard",
    price: 100,
    currency: "USD",
    quantity: 999999,
    soldCount: 0,
    isActive: true,
    salesStart: null,
    salesEnd: null,
    sortOrder: 1,
    ...over,
  };
}

describe("isTierOnSale", () => {
  it("accepts an active tier with an open window", () => {
    expect(isTierOnSale(tier({ salesStart: day(-1), salesEnd: day(1) }), NOW)).toBe(true);
  });

  it("treats null window bounds as open", () => {
    expect(isTierOnSale(tier({ salesStart: null, salesEnd: null }), NOW)).toBe(true);
  });

  it("rejects an inactive tier", () => {
    expect(isTierOnSale(tier({ isActive: false }), NOW)).toBe(false);
  });

  it("rejects a tier whose sales haven't started", () => {
    expect(isTierOnSale(tier({ salesStart: day(1) }), NOW)).toBe(false);
  });

  it("rejects a closed tier", () => {
    expect(isTierOnSale(tier({ salesEnd: day(-1) }), NOW)).toBe(false);
  });

  it("rejects a sold-out tier", () => {
    expect(isTierOnSale(tier({ quantity: 10, soldCount: 10 }), NOW)).toBe(false);
  });
});

describe("pickCurrentPricingTier", () => {
  it("returns null when the type has no tiers (caller falls back to base price)", () => {
    expect(pickCurrentPricingTier([], NOW)).toBeNull();
  });

  it("returns null when every tier is closed", () => {
    const tiers = [
      tier({ id: "eb", name: "Early Bird", sortOrder: 0, salesEnd: day(-5) }),
      tier({ id: "std", sortOrder: 1, salesEnd: day(-1) }),
    ];
    expect(pickCurrentPricingTier(tiers, NOW)).toBeNull();
  });

  it("charges Early Bird while it is still running", () => {
    const tiers = [
      tier({ id: "std", name: "Standard", sortOrder: 1, price: 200 }),
      tier({ id: "eb", name: "Early Bird", sortOrder: 0, price: 100, salesEnd: day(1) }),
    ];
    expect(pickCurrentPricingTier(tiers, NOW)?.id).toBe("eb");
  });

  it("moves on to Standard once Early Bird has closed", () => {
    const tiers = [
      tier({ id: "eb", name: "Early Bird", sortOrder: 0, price: 100, salesEnd: day(-1) }),
      tier({ id: "std", name: "Standard", sortOrder: 1, price: 200 }),
    ];
    expect(pickCurrentPricingTier(tiers, NOW)?.id).toBe("std");
  });

  it("skips a sold-out Early Bird rather than blocking the sale", () => {
    const tiers = [
      tier({ id: "eb", name: "Early Bird", sortOrder: 0, quantity: 5, soldCount: 5 }),
      tier({ id: "std", name: "Standard", sortOrder: 1 }),
    ];
    expect(pickCurrentPricingTier(tiers, NOW)?.id).toBe("std");
  });

  it("breaks ties on sortOrder, not array order", () => {
    // The organizer's ordering on the Registration Types page decides, so a
    // differently-ordered query result can't change what someone is charged.
    const tiers = [
      tier({ id: "onsite", name: "Onsite", sortOrder: 2, price: 300 }),
      tier({ id: "eb", name: "Early Bird", sortOrder: 0, price: 100 }),
      tier({ id: "std", name: "Standard", sortOrder: 1, price: 200 }),
    ];
    expect(pickCurrentPricingTier(tiers, NOW)?.id).toBe("eb");
  });
});
