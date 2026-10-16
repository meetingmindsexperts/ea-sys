/**
 * Shapes + price resolution for the PUBLIC ticket-type payload.
 *
 * Shared by the group registration form and the My Group "add people" dialog
 * so the two can never quote a different price for the same registration type
 * — they are the same purchase, made minutes or weeks apart.
 *
 * This mirrors the server's `pickCurrentPricingTier` rule (the tier on sale
 * NOW, else the base price). It is the DISPLAY side only: the price actually
 * charged is always resolved server-side at submission, so a stale page can
 * never fix a price.
 */
import { tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { isPresenterTierName } from "@/lib/presenter-tiers";

export interface PublicTier {
  id: string;
  name: string;
  price: number | string;
  canPurchase: boolean;
  sortOrder: number;
}

export interface PublicTicketType {
  id: string;
  name: string;
  price: number | string;
  currency: string | null;
  canPurchase: boolean;
  soldOut: boolean;
  pricingTiers: PublicTier[];
}

/** The price a member on this type pays NOW: the live tier, else base. */
export function livePrice(t: PublicTicketType): {
  price: number;
  tierName: string | null;
} {
  const onSale = t.pricingTiers.filter((p) => p.canPurchase);
  if (onSale.length > 0) {
    const tier = onSale.reduce((best, p) => (p.sortOrder < best.sortOrder ? p : best));
    return { price: Number(tier.price), tierName: tier.name };
  }
  return { price: Number(t.price), tierName: null };
}

/**
 * Types a member can actually be registered on right now, each carrying only
 * the rates a group may use. The server prices a member with
 * `pickOpenPublicRate`, which never uses a sponsor-link rate (it needs a
 * sponsor's code) or a presenter rate, and refuses a type that has rates but
 * none of those open. This drops the same rates, and the same types, so the
 * form never offers a type the server refuses or quotes a price it won't charge.
 */
export function purchasableTypes(types: PublicTicketType[], sponsorLinkSlugs: readonly string[] = []): PublicTicketType[] {
  return types.flatMap((t) => {
    if (t.pricingTiers.length === 0) return t.canPurchase ? [t] : [];
    const pricingTiers = t.pricingTiers.filter(
      (p) => !tierNeedsSponsorCode(p.name, sponsorLinkSlugs) && !isPresenterTierName(p.name),
    );
    return pricingTiers.some((p) => p.canPurchase) ? [{ ...t, pricingTiers }] : [];
  });
}
