/**
 * How long a personal link an organiser sends stays valid: the survey
 * invitation and the registration form (Oct 16, 2026). One rule for both, so
 * the two dialogs cannot disagree.
 *
 * The organiser types a whole number of days. It began as a 3/5/7/10
 * dropdown for surveys and was changed on Sep 17, 2026 because organisers
 * wanted 15, 30 and 45. The bounds are a typo guard, not a product rule: at
 * least one day, at most a year, so `450` meant for 45 cannot mint links that
 * outlive the event by over a year.
 *
 * CLIENT-SAFE: the send dialogs import it for their inline check, so no
 * Node-only imports here.
 */
import { z } from "zod";

export const MIN_LINK_EXPIRY_DAYS = 1;
export const MAX_LINK_EXPIRY_DAYS = 365;

/** Used when a send carries no lifetime (the behaviour before it was configurable). */
export const DEFAULT_LINK_EXPIRY_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Builds the schema with the link's own name in its messages ("Survey link", "Registration link"). */
export function linkExpiryDaysSchema(label: string) {
  return z
    .number()
    .int(`${label} expiry must be a whole number of days`)
    .min(MIN_LINK_EXPIRY_DAYS, `${label} expiry must be at least ${MIN_LINK_EXPIRY_DAYS} day`)
    .max(MAX_LINK_EXPIRY_DAYS, `${label} expiry can be at most ${MAX_LINK_EXPIRY_DAYS} days`);
}

/**
 * Parse what the organiser typed. Digits only: "30" is 30; "3.5", "-2",
 * "1e2", " " and "" are all rejected rather than coerced, so the number that
 * is sent is the number they saw.
 */
export function parseLinkExpiryInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = linkExpiryDaysSchema("Link").safeParse(Number(trimmed));
  return parsed.success ? parsed.data : null;
}
