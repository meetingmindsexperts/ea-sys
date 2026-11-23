/**
 * Presenter registration settings (Aug 11, 2026).
 * See docs/PRESENTER_REGISTRATION_PLAN.md, decision D3.
 *
 * Abstract submitters get a real registration and a quote PDF, but by default
 * they are NOT invited to pay immediately. The organizer's own figure is that
 * roughly 1 abstract in 20-30 ends up actually paying: the rest are comped or
 * discounted once the abstract is accepted. Asking all 30 for money up front
 * would mean 29 invoices nobody owes, and refunds for whoever pays anyway.
 *
 * `payNowEnabled` turns that back on for events that do want payment at
 * submission. It is **opt-in**, and the polarity matters: a corrupted or
 * partially-written settings blob must resolve to "do not ask for money",
 * never to "ask everyone". Same fail-safe direction as `showRemainingTickets`.
 *
 * What it controls, since Nov 23, 2026 (owner): whether an abstract submitter
 * may pay ONLINE at all. Off, the registration their sign-up made carries no
 * Pay Now anywhere (emails, portal, the pay page) and the checkout refuses;
 * the organisers turn it on when they want payment, typically once decisions
 * are announced. `authorPaymentOnHold` in author-payment-hold.ts is the rule
 * every pay door asks. Until that day it governed the sign-up's own emails
 * only and the portal kept its Pay Now either way. It never changes what
 * anyone owes.
 *
 * KEPT ON PURPOSE (owner, Nov 20, 2026). The switch was removed for a day,
 * because MM Group's house rule is that presenter registration is always pay
 * later, and put back before it shipped: another organisation on the platform
 * may collect at submission. It stays per event and off by default; no
 * production event had it on when this was written.
 *
 * Client-safe: pure, no imports.
 */

export interface PresenterRegistrationSettings {
  /** Abstract submitters may pay online (author-payment-hold.ts). Default false. */
  payNowEnabled: boolean;
}

export const DEFAULT_PRESENTER_REGISTRATION_SETTINGS: PresenterRegistrationSettings = {
  payNowEnabled: false,
};

/**
 * Read the event's presenter-registration settings. Strict `=== true` so any
 * absent, malformed or truthy-but-not-boolean value lands on "do not ask for
 * money" rather than on the expensive default.
 */
export function readPresenterRegistrationSettings(
  settings: unknown,
): PresenterRegistrationSettings {
  const raw = (settings as { presenterRegistration?: unknown } | null | undefined)
    ?.presenterRegistration;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_PRESENTER_REGISTRATION_SETTINGS;
  }
  return {
    payNowEnabled: (raw as Record<string, unknown>).payNowEnabled === true,
  };
}

/** Convenience for the one thing every caller actually asks. */
export function isPresenterPayNowEnabled(settings: unknown): boolean {
  return readPresenterRegistrationSettings(settings).payNowEnabled;
}
