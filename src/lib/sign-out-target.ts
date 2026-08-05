/**
 * Where sign-out lands (owner report Aug 5, 2026): attendee-side roles
 * (SUBMITTER, REGISTRANT) sign in through the EVENT login page
 * (/e/[slug]/login — the abstract/proposal/registration sign-in), so signing
 * them out to the internal /login dead-ends them on a page they never use.
 *
 * Resolution: the header passes the event the person is currently on, else
 * the first event their account is linked to (useEvents is role-scoped —
 * a submitter/registrant sees only their own events, usually exactly one; a
 * multi-event registrant lands on the first, which still beats /login).
 * Staff roles (and anyone with no resolvable event) keep /login.
 *
 * The redirect param makes re-login land straight back on their portal:
 * SUBMITTER → the neutral My Details page (safe-internal-path branch of the
 * event login), REGISTRANT → the event-scoped My Registration. REVIEWER is
 * deliberately NOT event-routed (they may span events/orgs and the internal
 * login works for them) — widen here if the owner asks.
 *
 * Client-safe (pure, no imports).
 */

export interface SignOutEventRef {
  id: string;
  slug?: string | null;
}

export function signOutCallbackUrl(
  role: string | null | undefined,
  event: SignOutEventRef | null | undefined,
): string {
  if (role !== "SUBMITTER" && role !== "REGISTRANT") return "/login";
  if (!event?.slug) return "/login";
  if (role === "REGISTRANT") return `/e/${event.slug}/login?redirect=registration`;
  return `/e/${event.slug}/login?redirect=${encodeURIComponent(`/events/${event.id}/my-details`)}`;
}
