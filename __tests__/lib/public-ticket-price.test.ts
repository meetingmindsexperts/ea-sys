/**
 * The group form's type list and price quotes (public-ticket-price.ts) must
 * follow the server's rule (pickOpenPublicRate): never a sponsor-link or
 * presenter rate, and no type the server would refuse (LOW 1 of the c4a12f28
 * review, Oct 16, 2026). On BHS2026, Exhibitor and Symposium Speaker have only
 * the Inclusive sponsor rate, so a group could fill them in and be refused.
 */
import { describe, it, expect } from "vitest";
import { livePrice, purchasableTypes, type PublicTicketType, type PublicTier } from "@/lib/public-ticket-price";

const rate = (over: Partial<PublicTier>): PublicTier => ({ id: "r", name: "Early Bird", price: 250, canPurchase: true, sortOrder: 0, ...over });
const type = (over: Partial<PublicTicketType>): PublicTicketType => ({
  id: "t", name: "Physician", price: 0, currency: "USD", canPurchase: true, soldOut: false, pricingTiers: [], ...over,
});

describe("purchasableTypes for groups", () => {
  const exhibitor = type({ id: "exh", name: "Exhibitor", pricingTiers: [rate({ id: "inc", name: "Inclusive", price: 0 })] });
  const physician = type({
    id: "phys",
    pricingTiers: [rate({ id: "inc", name: "Inclusive", price: 0, sortOrder: 0 }), rate({ id: "eb", name: "Early Bird", price: 250, sortOrder: 1 })],
  });

  it("drops a type whose only open rate is a sponsor link", () => {
    expect(purchasableTypes([exhibitor, physician], ["inclusive"]).map((t) => t.id)).toEqual(["phys"]);
  });

  it("quotes the rate the server charges, never the $0 sponsor rate that sorts first", () => {
    const [phys] = purchasableTypes([physician], ["inclusive"]);
    expect(livePrice(phys)).toEqual({ price: 250, tierName: "Early Bird" });
  });

  it("drops presenter-only types, and keeps a type with no rates on its own price", () => {
    const presenterOnly = type({ id: "pres", pricingTiers: [rate({ name: "Presenter Early Bird", price: 0 })] });
    const flat = type({ id: "flat", price: 100 });
    expect(purchasableTypes([presenterOnly, flat]).map((t) => t.id)).toEqual(["flat"]);
  });

  it("drops a type with rates but none on sale, even if the type itself says it can be bought", () => {
    const closed = type({ id: "closed", pricingTiers: [rate({ canPurchase: false })] });
    expect(purchasableTypes([closed])).toEqual([]);
  });

  it("without sponsor links, behaves as before", () => {
    expect(purchasableTypes([exhibitor]).map((t) => t.id)).toEqual(["exh"]);
  });
});
