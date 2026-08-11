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
 * What it controls is only whether the submitter is INVITED to pay at
 * submission (the Pay Now call to action on their confirmation). It never
 * changes what they owe, and the registrant portal keeps its own Pay Now
 * either way, because that is how paying later actually happens.
 *
 * Client-safe: pure, no imports.
 */

export interface PresenterRegistrationSettings {
  /** Show Pay Now on the abstract-submitter confirmation. Default false. */
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
