/**
 * Submitter surface separation (July 30, 2026, owner decision) — a SUBMITTER
 * who signed up through the session-proposal flow must see ONLY Session
 * Proposals, and an abstract signup ONLY Abstracts ("keep them separate, we
 * may merge later"). Both directions; hide + redirect only (no API hard-block
 * — these are people the organizer invited, this is product separation, not a
 * security boundary).
 *
 * The signal is `Speaker.submitterSource` ("abstract" | "proposal" | "both"
 * | null), stamped at self-signup — a door GRANTS its surface and never
 * removes the other (owner decision Aug 4, 2026: the two registers are
 * independent; a person who has used both doors is "both" and sees both
 * surfaces). `null` (legacy speakers, organizer-added) counts as "abstract"
 * — every pre-existing submitter came through the abstract flow.
 *
 * Content overrides source in BOTH directions: someone who actually HAS rows
 * on the other surface (e.g. an organizer later invites a proposer to submit
 * an abstract) sees that surface too — hiding rows a person owns is never ok.
 *
 * ONE truth table, consumed by the sidebar AND the page-level redirect guard
 * (useSubmitterSurfaceGuard) so the two can't drift. Client-safe (pure).
 */

export interface SubmitterSurfaceContext {
  /** "abstract" | "proposal" | "both" | null (null = legacy → abstract). */
  submitterSource: string | null;
  abstractCount: number;
  proposalCount: number;
}

export function submitterSeesAbstracts(ctx: SubmitterSurfaceContext): boolean {
  // "abstract", "both" and null (legacy) all see abstracts; a proposal-only
  // person sees them only once they actually HAVE one (content override).
  return ctx.submitterSource !== "proposal" || ctx.abstractCount > 0;
}

export function submitterSeesProposals(ctx: SubmitterSurfaceContext): boolean {
  return ctx.submitterSource === "proposal" || ctx.submitterSource === "both" || ctx.proposalCount > 0;
}

/**
 * Where to send a submitter who landed on a surface they can't see: My
 * Details — ONE shared landing for both flows (owner decision Aug 4, 2026).
 * The page is surface-neutral and adapts its actions to the person's
 * surfaces, so it's a safe home for everyone.
 */
// The ctx param is kept for call-site compatibility (the guard passes it) —
// deliberately unused since the home no longer depends on surfaces.
export function submitterHomePath(eventId: string, ctx?: SubmitterSurfaceContext): string {
  void ctx;
  return `/events/${eventId}/abstracts/profile`;
}
