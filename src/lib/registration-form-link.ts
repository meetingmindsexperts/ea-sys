/**
 * The personal registration form link carries a rate
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md, Oct 16, 2026).
 *
 * The rate rides in the VerificationToken's identifier, so no schema change:
 *   `regform:<registrationId>:<rate>`  where <rate> is a rate-name slug
 *                                       (`early-bird`) or `complimentary`
 *   `reg:<registrationId>`             the older form, still valid for links
 *                                       already in inboxes: no rate, the open
 *                                       public rate applies as before.
 *
 * Client-safe.
 */
import { registerTierSlug } from "@/lib/main-register-tiers";

/**
 * The key for "no rate, no charge". It starts with an underscore, which a rate
 * slug never contains (registerTierSlug keeps only a-z, 0-9 and "-"), so a
 * rate actually named "Complimentary" stays an ordinary rate (review L6).
 */
export const COMPLIMENTARY_RATE = "_complimentary";

/** What the organiser chose when sending. */
export type RegistrationFormRate = { kind: "rate"; slug: string } | { kind: "complimentary" };

const NEW_PREFIX = "regform:";
const OLD_PREFIX = "reg:";

export function registrationFormIdentifier(registrationId: string, rate: RegistrationFormRate): string {
  const rateKey = rate.kind === "complimentary" ? COMPLIMENTARY_RATE : registerTierSlug(rate.slug);
  return `${NEW_PREFIX}${registrationId}:${rateKey}`;
}

/** Both identifier forms a registration's links may use, for revoking them all. */
export function registrationFormIdentifierPrefixes(registrationId: string): { exact: string; startsWith: string } {
  return { exact: `${OLD_PREFIX}${registrationId}`, startsWith: `${NEW_PREFIX}${registrationId}:` };
}

/**
 * Reads either identifier form. Null for anything else (another token type
 * presented on the completion route). `rate` is null for the older form.
 */
export function parseRegistrationFormIdentifier(
  identifier: string,
): { registrationId: string; rate: RegistrationFormRate | null } | null {
  if (identifier.startsWith(NEW_PREFIX)) {
    const rest = identifier.slice(NEW_PREFIX.length);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return null;
    const registrationId = rest.slice(0, sep);
    const rateKey = rest.slice(sep + 1);
    const rate: RegistrationFormRate =
      rateKey === COMPLIMENTARY_RATE ? { kind: "complimentary" } : { kind: "rate", slug: rateKey };
    return { registrationId, rate };
  }
  if (identifier.startsWith(OLD_PREFIX)) {
    const registrationId = identifier.slice(OLD_PREFIX.length);
    return registrationId ? { registrationId, rate: null } : null;
  }
  return null;
}

/** Why a registration got no link. Reported to the organiser, never silent. */
export type RegistrationFormSkipReason =
  | "NOT_FOUND"
  | "CANCELLED"
  | "HAS_ACCOUNT"
  | "ALREADY_COMPLETED"
  | "MONEY_RECORDED"
  | "IN_GROUP"
  | "PROMO_APPLIED"
  | "RATE_NOT_ON_TYPE"
  | "RATE_NOT_ON_SALE"
  | "NO_SPONSOR"
  | "RATE_SOLD_OUT"
  | "CHANGED";

export const REGISTRATION_FORM_SKIP_LABELS: Record<RegistrationFormSkipReason, string> = {
  NOT_FOUND: "not found on this event",
  CANCELLED: "cancelled",
  HAS_ACCOUNT: "already completed (has an account)",
  ALREADY_COMPLETED: "already completed the registration form",
  MONEY_RECORDED: "already paid or invoiced",
  IN_GROUP: "part of a group registration",
  PROMO_APPLIED: "has a promo code applied",
  RATE_NOT_ON_TYPE: "their registration type has no rate of that name",
  RATE_NOT_ON_SALE: "the rate is not on sale for their registration type",
  NO_SPONSOR: "no sponsor chosen or on the registration",
  RATE_SOLD_OUT: "no seats left at that rate",
  CHANGED: "changed while sending; try again",
};
