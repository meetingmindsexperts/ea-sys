/**
 * Presenter pricing tiers (Aug 11, 2026). See docs/PRESENTER_REGISTRATION_PLAN.md.
 *
 * WHAT CHANGED. A single tier literally named "Presenter" used to exist on
 * every registration type, and exactly one line of code knew about it: the
 * public register redirect skipped it so nobody landed on it by accident. It
 * was auto-seeded 69 times across prod and had **zero registrations, ever**,
 * because the abstract door minted a free Faculty comp and bypassed it. On the
 * live conference it was even priced identically to Early Bird.
 *
 * Organizers asked for presenters to register like delegates, on their own
 * rate ladder. So one "Presenter" tier becomes a FAMILY of them, `Presenter
 * Early Bird` / `Presenter Standard`, and three separate places need to answer
 * "is this a presenter tier?": the redirect that keeps them off the delegate
 * path, the abstract signup form that lists their rates, and the door that
 * picks the one currently on sale. Three string comparisons would drift, so
 * this is the one predicate.
 *
 * MATCHING IS BY NAME PREFIX, deliberately. There is no column for it: a tier
 * is a name and a price hanging off a registration type. A prefix keeps the
 * existing dead `Presenter` tiers matching (so they are recognised, not
 * orphaned) while admitting the new pair, and lets an organizer invent
 * `Presenter Onsite` without a code change.
 *
 * Client-safe: pure string work, no imports.
 */

/** Tier names seeded onto a newly created registration type. */
export const DEFAULT_TIER_NAMES = [
  "Early Bird",
  "Standard",
  "Onsite",
  "Presenter Early Bird",
  "Presenter Standard",
];

/**
 * The delegate tier ladder. Since Sep 25, 2026 it is only the DEFAULT for where
 * the main /register link lands; the organiser's own list in Settings →
 * Registration replaces it (src/lib/main-register-tiers.ts). A tier outside
 * the list is no longer a fall-through candidate.
 */
export const DELEGATE_TIER_PRIORITY = ["early-bird", "standard", "onsite"];

const PRESENTER_PREFIX = "presenter";

/** Slugify a tier name the same way the public register URLs do. */
export function tierSlug(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

/**
 * True for `Presenter`, `Presenter Early Bird`, `Presenter Standard` and any
 * future `Presenter *`. Guards against matching an unrelated name that merely
 * starts with the letters (a hypothetical "Presenters Guild Member") by
 * requiring the prefix to end the string or be followed by a separator.
 */
export function isPresenterTierName(name: string | null | undefined): boolean {
  if (!name) return false;
  const slug = tierSlug(name);
  if (slug === PRESENTER_PREFIX) return true;
  return slug.startsWith(`${PRESENTER_PREFIX}-`);
}

/** Minimal shape of a tier as the public event API returns it. */
export interface PresenterTierCandidate {
  id: string;
  name: string;
  price: number | string;
  currency?: string | null;
  sortOrder?: number | null;
  /** Computed server-side: in its sales window and not sold out. */
  canPurchase?: boolean;
}

export interface PresenterTicketTypeCandidate {
  id: string;
  name: string;
  isActive?: boolean;
  pricingTiers?: PresenterTierCandidate[] | null;
}

/**
 * One registration type and the rate an author is offered on it: its presenter
 * rate, or (an event with none, author-rates.ts) its ordinary rate on sale.
 * `tierId` is null only for a type that has no rates and is sold at its own price.
 */
export interface PresenterRateOption {
  ticketTypeId: string;
  ticketTypeName: string;
  tierId: string | null;
  tierName: string;
  price: number;
  currency: string;
}

/**
 * The presenter rates a submitter may pick from right now: for each
 * registration type, the presenter tier that is on sale, lowest `sortOrder`
 * first so Presenter Early Bird wins over Presenter Standard while both are
 * open.
 *
 * Shared by the signup form (which renders these) and the door (which resolves
 * the tier SERVER-side from the chosen type). The door must never take a tier
 * id or a price from the client, and sharing the resolution is what keeps the
 * price the submitter was shown identical to the one they are charged.
 *
 * An empty result is meaningful, not an error: no presenter rate is on sale.
 * What an author is offered then is decided by `authorRateOptions`
 * (author-rates.ts); since Nov 20, 2026 it is never a free Faculty registration.
 */
export function presenterRateOptions(
  ticketTypes: PresenterTicketTypeCandidate[] | null | undefined,
): PresenterRateOption[] {
  if (!Array.isArray(ticketTypes)) return [];
  const options: PresenterRateOption[] = [];
  for (const tt of ticketTypes) {
    if (tt.isActive === false) continue;
    const open = (tt.pricingTiers ?? [])
      .filter((t) => isPresenterTierName(t.name) && t.canPurchase !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const tier = open[0];
    if (!tier) continue;
    const price = Number(tier.price);
    if (!Number.isFinite(price)) continue;
    options.push({
      ticketTypeId: tt.id,
      ticketTypeName: tt.name,
      tierId: tier.id,
      tierName: tier.name,
      price,
      currency: tier.currency || "USD",
    });
  }
  return options;
}
