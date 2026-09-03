/**
 * Session-proposal submission deadline (Aug 6, 2026, organizer request) —
 * client-safe, pure. Mirrors the abstract deadline (`settings.abstractDeadline`)
 * with a sibling settings key, `settings.sessionProposalDeadline` (ISO string,
 * absent/null = no deadline).
 *
 * Semantics: once the deadline passes, session-proposal intake ENDS
 * automatically — the public proposer signup door closes AND a SUBMITTER can
 * no longer create or submit a proposal (drafts stay readable/editable; only
 * new intake + submission stop). Organizer staff are exempt (post-deadline
 * entries on someone's behalf are a deliberate staff action, same philosophy
 * as the grant flow's sales-window override). The organizer extends the
 * window by simply editing the date — the event PUT refuses setting a date
 * already in the past (`DEADLINE_IN_PAST`), so "extend" always means forward.
 *
 * The abstract deadline is expected to adopt the same helpers later (owner:
 * "extends to abstracts too, but will do that later").
 */

/** An ISO deadline under `key` in an Event.settings blob (defensive parse). */
function readIsoDeadline(settings: unknown, key: string): string | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>)[key];
  if (typeof raw !== "string" || !raw.trim()) return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

/** The session-proposal deadline from an Event.settings blob. */
export function readSessionProposalDeadline(settings: unknown): string | null {
  return readIsoDeadline(settings, "sessionProposalDeadline");
}

/**
 * The abstract-submission deadline from an Event.settings blob. Same key the
 * public event API and the submitter door read raw (`settings.abstractDeadline`);
 * this is the reader the file header promised they would adopt.
 */
export function readAbstractDeadline(settings: unknown): string | null {
  return readIsoDeadline(settings, "abstractDeadline");
}

/** True when a (nullable) ISO deadline exists and is already behind us. */
export function isDeadlinePassed(deadline: string | null | undefined): boolean {
  if (!deadline) return false;
  const at = new Date(deadline).getTime();
  return !Number.isNaN(at) && Date.now() > at;
}
