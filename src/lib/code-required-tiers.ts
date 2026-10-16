/**
 * Rates whose link needs a sponsor's code (Oct 16, 2026).
 *
 * MM Group runs a sponsor channel as a rate: `/e/<slug>/register/inclusive`
 * lists every registration type at $0, and sponsors pass that link to their
 * people, while `/register/early-bird` is for everyone else. A rate's link is
 * unlisted, not locked, so anyone who found the Inclusive link could register
 * free. The organiser now marks such a rate here, by NAME like the main link
 * (src/lib/main-register-tiers.ts), because one rate name spans every
 * registration type: marking "Inclusive" covers Physician, Nurse, Exhibitor
 * and any type added later, with nothing to tick per type.
 *
 * Only a code whose sponsor covers the fee opens a marked rate (owner ruling):
 * a discount code such as ABHLS26 keeps working on Early Bird but cannot turn
 * the $0 sponsor rate into a free door. Staff adding a registration from the
 * dashboard are exempt.
 *
 * Stored as rate-name slugs in `Event.settings.codeRequiredTiers`. Client-safe.
 */
import { registerTierSlug } from "@/lib/main-register-tiers";

export const CODE_REQUIRED_TIERS_SETTING = "codeRequiredTiers";
const MAX_ENTRIES = 50;

/** The marked rate names, as slugs. Anything that is not an array means none. */
export function readCodeRequiredTiers(settings: unknown): string[] {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)[CODE_REQUIRED_TIERS_SETTING]
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const slug = registerTierSlug(value);
    if (!slug || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Does this rate (by its name) need a sponsor's code on this event? */
export function tierNeedsSponsorCode(tierName: string | null | undefined, markedSlugs: readonly string[]): boolean {
  return !!tierName && markedSlugs.includes(registerTierSlug(tierName));
}

/** A code that may open a marked rate: its sponsor covers the whole fee. */
export function isSponsorCoveredCode(promo: { sponsorCoversFee?: boolean | null; sponsorId?: string | null } | null | undefined): boolean {
  return promo?.sponsorCoversFee === true && !!promo.sponsorId;
}
