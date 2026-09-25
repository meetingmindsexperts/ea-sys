/**
 * Where the main public link, `/e/<slug>/register`, lands (Sep 25, 2026).
 *
 * The link redirects to ONE pricing tier's form, `/e/<slug>/register/<tier>`.
 * It used to pick the first tier on sale by a fixed priority, Early Bird then
 * Standard then Onsite, but any other tier name sorted last and was still
 * picked. So an event whose delegate tiers were all closed sent the public to
 * whatever else was open: on prod, ibc2026 would have landed visitors on its
 * Complimentary or Inclusive rate the day it was published.
 *
 * Two inputs, deliberately from two places (owner decisions, Sep 25):
 *
 * - WHICH rates the link may use is ticked by the organiser on the
 *   Registration Types page and stored as tier-name slugs in
 *   `Event.settings.mainRegisterTiers`. By NAME because that is how the public
 *   URLs work: one tier name spans every registration type. A tier cannot say
 *   for itself whether it is a public rate or a private one (Complimentary and
 *   Workshop look identical to the code), so this has to be a setting.
 * - The ORDER is the tiers' own order (`sortOrder`, as arranged on the
 *   Registration Types page), so there is no second ordering to keep in step.
 *
 * - Absent key: Early Bird, Standard, Onsite are ticked, so an event nobody
 *   has configured behaves as before minus the fall-through.
 * - Empty array: the main link lands nowhere and shows "Registration Closed";
 *   only direct tier links work. A legitimate setup, not an error.
 * - An unticked tier is NOT hidden: its direct link still works, like a
 *   private rate (owner decision).
 * - Presenter tiers can never be ticked: they belong to the abstract signup,
 *   and the register API refuses them from the public anyway.
 *
 * Client-safe: pure string work.
 */
import { DELEGATE_TIER_PRIORITY, isPresenterTierName } from "@/lib/presenter-tiers";

/** Ticked until an organiser saves their own choice. */
export const DEFAULT_MAIN_REGISTER_TIERS: readonly string[] = DELEGATE_TIER_PRIORITY;

/** Cap on stored entries; a real event has a handful of tier names. */
const MAX_ENTRIES = 50;

/** The tier-name slug the public register URLs use, byte for byte. */
export function registerTierSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The event's ticked names, cleaned: slugs, deduplicated, presenter tiers
 * dropped. Order carries no meaning. Never throws; anything that is not an
 * array means "not configured".
 */
export function readMainRegisterTiers(settings: unknown): string[] {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).mainRegisterTiers
      : undefined;
  if (!Array.isArray(raw)) return [...DEFAULT_MAIN_REGISTER_TIERS];

  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const slug = registerTierSlug(value);
    if (!slug || isPresenterTierName(slug) || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

interface TierCandidate {
  name: string;
  sortOrder?: number | null;
}

/**
 * Every non-presenter tier across the registration types, in tier order:
 * `sortOrder` first, then registration-type order, then position. Shared by
 * the redirect and the Registration Types control so both read one order.
 */
function tiersInOrder<T extends TierCandidate>(
  ticketTypes: ReadonlyArray<{ pricingTiers?: T[] | null }> | null | undefined,
): T[] {
  return (ticketTypes ?? [])
    .flatMap((tt, typeIndex) =>
      (tt.pricingTiers ?? []).map((tier, tierIndex) => ({ tier, typeIndex, tierIndex })),
    )
    .filter(({ tier }) => !isPresenterTierName(tier.name))
    .sort(
      (a, b) =>
        (a.tier.sortOrder ?? a.tierIndex) - (b.tier.sortOrder ?? b.tierIndex) ||
        a.typeIndex - b.typeIndex ||
        a.tierIndex - b.tierIndex,
    )
    .map(({ tier }) => tier);
}

/** Distinct tier names in tier order, as `{ slug, name }`, for the control. */
export function orderedTierNames(
  ticketTypes: ReadonlyArray<{ pricingTiers?: TierCandidate[] | null }> | null | undefined,
): { slug: string; name: string }[] {
  const seen = new Set<string>();
  const out: { slug: string; name: string }[] = [];
  for (const tier of tiersInOrder(ticketTypes)) {
    const slug = registerTierSlug(tier.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: tier.name });
  }
  return out;
}

/**
 * The tier the main link should land on: in tier order, the first one that is
 * on sale and whose name is ticked. Undefined means none, and the caller shows
 * the closed page.
 */
export function pickMainRegisterTier<T extends TierCandidate & { canPurchase: boolean }>(
  ticketTypes: ReadonlyArray<{ pricingTiers?: T[] | null }> | null | undefined,
  ticked: readonly string[],
): T | undefined {
  return tiersInOrder(ticketTypes).find(
    (t) => t.canPurchase && ticked.includes(registerTierSlug(t.name)),
  );
}
