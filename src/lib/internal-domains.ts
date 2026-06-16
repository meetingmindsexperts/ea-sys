/**
 * Internal email domains — addresses that belong to the organization itself.
 *
 * Rule (June 2026): anyone who registers with an internal-domain email is one
 * of "us" and gets the event's organization attached to their account, even if
 * they first appear as an attendee (REGISTRANT). This lets an internal person
 * be promoted to a team role later without the global-email-uniqueness check
 * blocking them, while still keeping their own registrations.
 *
 * Two tiers, by whether the address is a real mailbox:
 *
 *  - VERIFIED (`meetingmindsdubai.com`) — real staff mailboxes. They must
 *    **verify their email** (click a link) before the org is attached / they
 *    count as internal. Until then they're a normal external registrant. This
 *    stops someone who doesn't actually control a @meetingmindsdubai.com
 *    address from auto-claiming internal status.
 *
 *  - TRUSTED (`meetingmindsexperts.com`, `meetingmindsgroup.com`) — "temp"
 *    account domains for short-lived staff/volunteers. The addresses may not be
 *    real mailboxes, so they deliberately SKIP verification and get the org
 *    attached immediately; an admin deletes the accounts from Settings → Users
 *    when done.
 *
 * Note: an admin who explicitly invites/promotes someone (Settings → Users) is
 * a trusted human action and does NOT require the person to have verified — the
 * verification gate only governs the *automatic* org-attach at registration.
 *
 * Leaf module: no imports, safe for any bundle / runtime.
 */
export const VERIFIED_INTERNAL_DOMAINS = ["meetingmindsdubai.com"] as const;

export const TRUSTED_INTERNAL_DOMAINS = [
  "meetingmindsexperts.com",
  "meetingmindsgroup.com",
] as const;

/** Every internal domain, regardless of tier. */
export const INTERNAL_EMAIL_DOMAINS = [
  ...VERIFIED_INTERNAL_DOMAINS,
  ...TRUSTED_INTERNAL_DOMAINS,
] as const;

/** Extract the lowercased domain part of an email, or "" if malformed. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** True when the email belongs to ANY internal (own-organization) domain. */
export function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (INTERNAL_EMAIL_DOMAINS as readonly string[]).includes(emailDomain(email));
}

/**
 * Trusted internal (temp) domains — get the org attached immediately at
 * registration, no verification.
 */
export function isTrustedInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (TRUSTED_INTERNAL_DOMAINS as readonly string[]).includes(emailDomain(email));
}

/**
 * Verified internal domains — the email must be verified (click-the-link)
 * before the org is attached. Drives the verify-email flow at registration.
 */
export function needsEmailVerification(email: string | null | undefined): boolean {
  if (!email) return false;
  return (VERIFIED_INTERNAL_DOMAINS as readonly string[]).includes(emailDomain(email));
}
