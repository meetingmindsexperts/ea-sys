/**
 * Sponsor links (Oct 16, 2026): which rates need a sponsor's code, and which
 * rate a flow with no link (groups, the completion form) may price on.
 */
import { describe, it, expect } from "vitest";
import { isSponsorCoveredCode, readCodeRequiredTiers, tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { pickNamedGroupRate, pickOpenPublicRate, type PricingTierCandidate } from "@/lib/current-pricing-tier";

const NOW = new Date("2026-10-16T12:00:00Z");

function rate(over: Partial<PricingTierCandidate> = {}): PricingTierCandidate {
  return {
    id: "t", name: "Early Bird", price: 80, currency: "USD", quantity: 999, soldCount: 0,
    isActive: true, salesStart: null, salesEnd: null, sortOrder: 0, ...over,
  };
}

describe("readCodeRequiredTiers / tierNeedsSponsorCode", () => {
  it("normalises names to slugs, dedupes, and ignores junk", () => {
    expect(readCodeRequiredTiers({ codeRequiredTiers: ["Inclusive", "inclusive", 3, "Sponsor Rate!"] })).toEqual([
      "inclusive",
      "sponsor-rate",
    ]);
    expect(readCodeRequiredTiers({ codeRequiredTiers: "inclusive" })).toEqual([]);
    expect(readCodeRequiredTiers(null)).toEqual([]);
  });

  it("matches a rate by name whatever its case or punctuation", () => {
    const marked = readCodeRequiredTiers({ codeRequiredTiers: ["inclusive"] });
    expect(tierNeedsSponsorCode("INCLUSIVE", marked)).toBe(true);
    expect(tierNeedsSponsorCode("Early Bird", marked)).toBe(false);
    expect(tierNeedsSponsorCode(null, marked)).toBe(false);
  });

  it("opens a marked rate only with a code whose sponsor covers the fee", () => {
    expect(isSponsorCoveredCode({ sponsorCoversFee: true, sponsorId: "s1" })).toBe(true);
    expect(isSponsorCoveredCode({ sponsorCoversFee: true, sponsorId: null })).toBe(false);
    expect(isSponsorCoveredCode({ sponsorCoversFee: false, sponsorId: "s1" })).toBe(false);
    expect(isSponsorCoveredCode(null)).toBe(false);
  });
});

describe("pickOpenPublicRate", () => {
  it("skips sponsor-link and presenter rates and takes the lowest sortOrder of the rest", () => {
    const tiers = [
      rate({ id: "inc", name: "Inclusive", price: 0, sortOrder: 0 }),
      rate({ id: "pres", name: "Presenter", price: 0, sortOrder: 1 }),
      rate({ id: "std", name: "Standard", sortOrder: 3 }),
      rate({ id: "eb", name: "Early Bird", sortOrder: 2 }),
    ];
    expect(pickOpenPublicRate(tiers, ["inclusive"], NOW)).toEqual({ tier: tiers[3], noRateOnSale: false });
  });

  it("reports no rate on sale when a type has rates but none a public flow may use", () => {
    const tiers = [rate({ name: "Inclusive", price: 0 }), rate({ name: "Early Bird", isActive: false })];
    expect(pickOpenPublicRate(tiers, ["inclusive"], NOW)).toEqual({ tier: null, noRateOnSale: true });
  });

  it("a type with no rates at all is not 'no rate on sale' (it prices on its own price)", () => {
    expect(pickOpenPublicRate([], ["inclusive"], NOW)).toEqual({ tier: null, noRateOnSale: false });
  });
});

describe("pickNamedGroupRate", () => {
  const tiers = [rate({ id: "eb", name: "Early Bird" }), rate({ id: "std", name: "Standard", sortOrder: 1 })];
  it("takes the named rate, whatever its sort order", () => {
    expect(pickNamedGroupRate(tiers, "standard", [], NOW)).toEqual({ ok: true, tier: tiers[1] });
  });
  it("refuses a missing rate, a closed one, and sponsor-link or presenter rates", () => {
    expect(pickNamedGroupRate(tiers, "onsite", [], NOW)).toEqual({ ok: false, code: "RATE_NOT_ON_TYPE" });
    expect(pickNamedGroupRate([rate({ name: "Standard", isActive: false })], "standard", [], NOW)).toEqual({ ok: false, code: "SALES_ENDED" });
    expect(pickNamedGroupRate(tiers, "early-bird", ["early-bird"], NOW)).toEqual({ ok: false, code: "RATE_NOT_FOR_GROUPS" });
    expect(pickNamedGroupRate(tiers, "presenter-standard", [], NOW)).toEqual({ ok: false, code: "RATE_NOT_FOR_GROUPS" });
  });
});
