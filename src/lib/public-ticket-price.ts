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

/** Types a member can actually be registered on right now. */
export function purchasableTypes(types: PublicTicketType[]): PublicTicketType[] {
  return types.filter((t) => t.canPurchase || t.pricingTiers.some((p) => p.canPurchase));
}
