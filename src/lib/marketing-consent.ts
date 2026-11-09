/**
 * Marketing consent wording (Nov 9, 2026, docs/ACCOUNT_SIGNUP_PLAN.md §3).
 * Client-safe: the sign-up form and My Details show it, and the server stores
 * the version key beside the consent, so what a person agreed to can always be
 * shown later. Change the text, change the version.
 *
 * Consent is only ever given by ticking an UNTICKED box. Sending it to
 * Mailchimp is the owner's n8n flow reading contacts_centralv1, once that
 * table has the column; EA-SYS never talks to Mailchimp.
 */
export const MARKETING_CONSENT_WORDING_VERSION = "2026-11-09";

export const MARKETING_CONSENT_TEXT =
  "Send me news about upcoming events, CME and programmes. I can unsubscribe at any time.";
