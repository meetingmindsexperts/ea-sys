/**
 * Where the main /e/<slug>/register link lands (Sep 25, 2026). The organiser's
 * list replaces the old fixed priority, whose fall-through sent the public to
 * ANY other tier on sale (ibc2026: Complimentary / Inclusive).
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAIN_REGISTER_TIERS,
  orderedTierNames,
  pickMainRegisterTier,
  readMainRegisterTiers,
  registerTierSlug,
} from "@/lib/main-register-tiers";

const tier = (name: string, canPurchase = true, sortOrder?: number) => ({ name, canPurchase, sortOrder });
const types = (...tiers: ReturnType<typeof tier>[][]) => tiers.map((pricingTiers) => ({ pricingTiers }));

describe("readMainRegisterTiers", () => {
  it("defaults to the delegate ladder when the event never configured it", () => {
    expect(readMainRegisterTiers(undefined)).toEqual(["early-bird", "standard", "onsite"]);
    expect(readMainRegisterTiers({})).toEqual([...DEFAULT_MAIN_REGISTER_TIERS]);
    expect(readMainRegisterTiers({ mainRegisterTiers: "standard" })).toEqual([...DEFAULT_MAIN_REGISTER_TIERS]);
  });

  it("keeps an explicit empty list: the main link then lands nowhere", () => {
    expect(readMainRegisterTiers({ mainRegisterTiers: [] })).toEqual([]);
  });

  it("slugifies, dedupes, drops non-strings and every presenter tier", () => {
    expect(
      readMainRegisterTiers({
        mainRegisterTiers: ["Workshop", "standard", "Standard", 7, "", "Presenter Early Bird", "presenter"],
      }),
    ).toEqual(["workshop", "standard"]);
  });

  it("matches the URL slug the public pages build", () => {
    expect(registerTierSlug("Early Bird")).toBe("early-bird");
    expect(registerTierSlug("  Day 1 / Workshop ")).toBe("day-1-workshop");
  });
});

describe("pickMainRegisterTier", () => {
  it("never falls through to a tier that is not on the list (the ibc2026 case)", () => {
    const tt = types(
      [tier("Early Bird", false), tier("Standard", false), tier("Complimentary")],
      [tier("Inclusive")],
    );
    expect(pickMainRegisterTier(tt, DEFAULT_MAIN_REGISTER_TIERS)).toBeUndefined();
  });

  it("follows the TIER order, not the order names were ticked in", async () => {
    const tt = types(
      [tier("Early Bird", true, 0), tier("Workshop", true, 3)],
      [tier("Standard", false, 1)],
    );
    // Ticked Workshop first: Early Bird still wins, it comes first in the tiers.
    expect(pickMainRegisterTier(tt, ["workshop", "early-bird"])?.name).toBe("Early Bird");
    // Early Bird unticked: the next ticked tier on sale, skipping Standard (not on sale).
    expect(pickMainRegisterTier(tt, ["workshop", "standard"])?.name).toBe("Workshop");
  });

  it("orders by sortOrder across types, then type order", () => {
    const tt = types(
      [tier("Onsite", true, 2), tier("Early Bird", false, 0)],
      [tier("Standard", true, 1)],
    );
    expect(pickMainRegisterTier(tt, DEFAULT_MAIN_REGISTER_TIERS)?.name).toBe("Standard");
  });

  it("finds a name on ANY registration type", () => {
    const tt = types([tier("Early Bird", false)], [tier("Onsite")]);
    expect(pickMainRegisterTier(tt, DEFAULT_MAIN_REGISTER_TIERS)?.name).toBe("Onsite");
  });

  it("never picks a presenter tier, even if the list were hand-edited to name one", () => {
    const tt = types([tier("Presenter Standard")]);
    expect(pickMainRegisterTier(tt, ["presenter-standard"])).toBeUndefined();
  });

  it("an empty list or no ticket types picks nothing", () => {
    expect(pickMainRegisterTier(types([tier("Standard")]), [])).toBeUndefined();
    expect(pickMainRegisterTier(null, DEFAULT_MAIN_REGISTER_TIERS)).toBeUndefined();
  });
});

describe("orderedTierNames", () => {
  it("lists each name once, in tier order, without presenter tiers", () => {
    const tt = types(
      [tier("Standard", true, 1), tier("Early Bird", true, 0), tier("Presenter Standard", true, 4)],
      [tier("Early Bird", true, 0), tier("Complimentary", true, 5)],
    );
    expect(orderedTierNames(tt)).toEqual([
      { slug: "early-bird", name: "Early Bird" },
      { slug: "standard", name: "Standard" },
      { slug: "complimentary", name: "Complimentary" },
    ]);
  });
});
