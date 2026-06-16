/**
 * Internal email domains — addresses that belong to the organization itself.
 *
 * Rule (June 2026): anyone who registers with an internal-domain email is one
 * of "us" and gets the event's organization attached to their account, even if
 * they first appear as an attendee (REGISTRANT). This lets an internal person
 * be promoted to a team role later without the global-email-uniqueness check
 * blocking them, while still keeping their own registrations.
 *
 * All three domains are trusted with NO email verification:
 *   - `meetingmindsdubai.com` — primary internal domain.
 *   - `meetingmindsexperts.com` / `meetingmindsgroup.com` — "temp" account
 *     domains. The addresses may not be real mailboxes (short-lived accounts
 *     for event-day staff/volunteers), so they deliberately skip verification;
 *     an admin deletes the accounts from Settings → Users when they're done.
 *
 * Leaf module: no imports, safe for any bundle / runtime.
 */
export const INTERNAL_EMAIL_DOMAINS = [
  "meetingmindsdubai.com",
  "meetingmindsexperts.com",
  "meetingmindsgroup.com",
] as const;

/** Extract the lowercased domain part of an email, or "" if malformed. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** True when the email belongs to an internal (own-organization) domain. */
export function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = emailDomain(email);
  return (INTERNAL_EMAIL_DOMAINS as readonly string[]).includes(domain);
}
