/**
 * "Sponsor covers the fee" on a promo code (Sep 29, 2026; owner decision:
 * an explicit switch, not inferred from a sponsor code at 100% off).
 *
 * A sponsor shares the REGULAR registration link with `?promo=CODE`; everyone
 * who registers with it (exhibitors, physicians, nurses...) is saved INCLUSIVE
 * and attributed to the sponsor, so the sponsor filter and export report them.
 * Without the switch the same code makes them COMPLIMENTARY with no sponsor.
 *
 * ONE rule for every writer (create, edit, the Promo Codes dialog), so a code
 * can never claim "the sponsor pays" while charging part of the fee or naming
 * no sponsor. Client-safe: no imports.
 */
export interface SponsorCoverState {
  sponsorCoversFee: boolean;
  sponsorId: string | null | undefined;
  discountType: string | null | undefined;
  discountValue: number | null | undefined;
  /** Required: the link is a bearer pass, so the sponsor's allocation must be capped. */
  maxUses: number | null | undefined;
}

/** Why this state is invalid, or null when it is fine. */
export function sponsorCoverError(state: SponsorCoverState): string | null {
  if (!state.sponsorCoversFee) return null;
  if (!state.sponsorId) return "\"Sponsor covers the fee\" needs a sponsor on the code.";
  if (state.discountType !== "PERCENTAGE" || Number(state.discountValue) !== 100) {
    return "\"Sponsor covers the fee\" needs the code to be 100% off.";
  }
  // Review MED 4 (Sep 29, 2026): anyone holding the link registers free, so an
  // uncapped code is an unlimited free pass. The cap is the sponsor's allocation.
  if (!state.maxUses || Number(state.maxUses) < 1) {
    return "\"Sponsor covers the fee\" needs a Max Total Uses (how many people the sponsor can bring).";
  }
  return null;
}

/** The regular registration link with the code applied. */
export function promoRegistrationLink(origin: string, slug: string, code: string): string {
  return `${origin}/e/${slug}/register?promo=${encodeURIComponent(code)}`;
}
