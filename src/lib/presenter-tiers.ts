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
 * Delegate tier ordering for the public register redirect. A tier outside this
 * list sorts last rather than being excluded, so a custom tier still works.
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
