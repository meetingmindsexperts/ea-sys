/**
 * "Which pricing tier is on sale right now" — the rule used when a tier has to
 * be assigned WITHOUT the organizer picking one from a shared link.
 *
 * On the public path the tier is never chosen by the registrant: the organizer
 * shares an Early-Bird / Standard / Onsite link and the register page matches
 * the tier from the URL category, while the person only picks their
 * registration TYPE (Physician / Nurse / …). So the tier normally encodes an
 * organizer decision about which sales window someone belongs to.
 *
 * The registration-completion flow has no such link: someone imported without a
 * registration type picks it on the completion form, and the price has to come
 * from somewhere. The rule (owner decision, July 27 2026) is "whatever is open
 * when they complete" — exactly what they'd have been charged registering
 * themselves that day, which is explainable to an attendee and needs no
 * organizer action. An organizer who wants a courtesy rate sets the type (and
 * tier) at import instead.
 *
 * Pure so the rule is unit-testable and lives in ONE place — the caller passes
 * the tiers it already loaded.
 */

export interface PricingTierCandidate {
  id: string;
  name: string;
  /** Prisma `Decimal` at runtime. */
  price: unknown;
  currency: string;
  quantity: number;
  soldCount: number;
  isActive: boolean;
  salesStart: Date | null;
  salesEnd: Date | null;
  sortOrder: number;
}

/** Is this tier on sale at `now` — active, inside its window, not sold out? */
export function isTierOnSale(tier: PricingTierCandidate, now: Date): boolean {
  if (!tier.isActive) return false;
  if (tier.salesStart && tier.salesStart > now) return false;
  if (tier.salesEnd && tier.salesEnd < now) return false;
  // A sold-out Early Bird shouldn't block the sale — fall through to the next
  // window, which is what the public page's `canPurchase` does.
  if (tier.soldCount >= tier.quantity) return false;
  return true;
}

/**
 * The tier to charge right now, or null when the type has no usable tier (no
 * tiers at all, all closed, or all sold out) — in which case the caller falls
 * back to the ticket type's own price.
 *
 * Ties are broken by `sortOrder` so the ordering the organizer set on the
 * Registration Types page (Early Bird → Standard → Onsite) decides, not
 * insertion order.
 */
export function pickCurrentPricingTier(
  tiers: PricingTierCandidate[],
  now: Date,
): PricingTierCandidate | null {
  const onSale = tiers.filter((t) => isTierOnSale(t, now));
  if (onSale.length === 0) return null;
  return onSale.reduce((best, t) => (t.sortOrder < best.sortOrder ? t : best));
}
