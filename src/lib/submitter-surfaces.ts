/**
 * Submitter surface separation (July 30, 2026, owner decision) — a SUBMITTER
 * who signed up through the session-proposal flow must see ONLY Session
 * Proposals, and an abstract signup ONLY Abstracts ("keep them separate, we
 * may merge later"). Both directions; hide + redirect only (no API hard-block
 * — these are people the organizer invited, this is product separation, not a
 * security boundary).
 *
 * The signal is `Speaker.submitterSource` ("abstract" | "proposal" | null),
 * stamped at self-signup, FIRST FLOW WINS. `null` (legacy speakers, organizer-
 * added) counts as "abstract" — every pre-existing submitter came through the
 * abstract flow.
 *
 * Content overrides source in BOTH directions: someone who actually HAS rows
 * on the other surface (e.g. an organizer later invites a proposer to submit
 * an abstract) sees that surface too — hiding rows a person owns is never ok.
 *
 * ONE truth table, consumed by the sidebar AND the page-level redirect guard
 * (useSubmitterSurfaceGuard) so the two can't drift. Client-safe (pure).
 */

export interface SubmitterSurfaceContext {
  /** "abstract" | "proposal" | null (null = legacy → abstract). */
  submitterSource: string | null;
  abstractCount: number;
  proposalCount: number;
}

export function submitterSeesAbstracts(ctx: SubmitterSurfaceContext): boolean {
  return ctx.submitterSource !== "proposal" || ctx.abstractCount > 0;
}

export function submitterSeesProposals(ctx: SubmitterSurfaceContext): boolean {
  return ctx.submitterSource === "proposal" || ctx.proposalCount > 0;
}

/** Where to send a submitter who landed on a surface they can't see. */
export function submitterHomePath(eventId: string, ctx: SubmitterSurfaceContext): string {
  return submitterSeesAbstracts(ctx)
    ? `/events/${eventId}/abstracts/profile`
    : `/events/${eventId}/session-proposals`;
}
