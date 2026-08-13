/**
 * Per-registration-type supporting document — client-safe, pure.
 *
 * An organizer ticks a box on ANY registration type to demand a document
 * substantiating that rate: an institutional letter for a Resident, a
 * membership card for a Member, a certificate for whatever comes next.
 *
 * ── Why a flag and not a name pattern ───────────────────────────────────────
 * This shipped on 2026-08-12 as a Resident-only letter, triggered by matching
 * `/resident|trainee/i` against the ticket type's NAME. That worked, and was
 * wrong for three reasons that only a flag fixes:
 *
 *   - It was INVISIBLE. Renaming "Resident" to "Junior Doctor" silently turned
 *     the requirement off. No warning, no log line; the form simply rendered
 *     without the field and the next registrant was admitted without the
 *     document that substantiates their discount.
 *   - It could not express INTENT. There was no way to ask Members for a card
 *     but not Residents for a letter, because the trigger was the name.
 *   - It COLLIDED. Production carries "Trainee / Student", which matched both
 *     the student rule and the resident rule, so it asked for a Student ID and
 *     a letter — correct, probably, but as a side effect of substring matching
 *     rather than because anyone chose it.
 *
 * The general class: configuration encoded in a name is configuration nobody
 * can see, change or audit. Same reasoning that retired the dormant
 * `settings.maxAttendees` JSON key in favour of a real column.
 *
 * ── Why TWO booleans and not one tri-state ──────────────────────────────────
 * `requiresDocument` asks the question; `documentRequired` decides whether a
 * missing answer blocks. A single `none | optional | required` enum reads
 * tidier and makes "show the field but do not block" unrepresentable — which
 * is the default the letter shipped with, for a real reason: some events want
 * the paperwork before they will hold a discounted place, others would rather
 * take the registration and chase it than lose the delegate at the form at
 * 11pm. That is a policy decision, not ours.
 *
 * Note the asymmetry with the member/student evidence fields beside it, which
 * are unconditionally required and still name-matched. Those ask for a number
 * the registrant knows by heart; this asks for a document they may not have to
 * hand. Converting those to per-type config is the same idea applied twice
 * more and is deliberately out of scope (docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md
 * §4), recorded so the inconsistency is a choice rather than an oversight.
 */

/** The document-policy fields of a ticket type. Structural, so any caller with
 *  a partial `select` satisfies it. */
export interface SupportingDocumentPolicy {
  requiresDocument?: boolean | null;
  documentRequired?: boolean | null;
  documentLabel?: string | null;
  documentInstructions?: string | null;
}

export const DEFAULT_DOCUMENT_LABEL = "Supporting Document";

/** Does a registration on this ticket type get asked for a document? */
export function requiresSupportingDocument(
  ticketType: SupportingDocumentPolicy | null | undefined,
): boolean {
  return ticketType?.requiresDocument === true;
}

/**
 * Does a MISSING document block the registration?
 *
 * Fails OPEN (not blocking) unless the type both asks for a document and is
 * explicitly set to require it. A half-configured type must never lock a
 * paying delegate out of a registration form: the cost of wrongly requiring is
 * a lost registration, the cost of wrongly not requiring is a document chased
 * by email.
 */
export function supportingDocumentBlocks(
  ticketType: SupportingDocumentPolicy | null | undefined,
): boolean {
  return requiresSupportingDocument(ticketType) && ticketType?.documentRequired === true;
}

/** The organizer's label, or a neutral default when they left it blank. */
export function supportingDocumentLabel(
  ticketType: SupportingDocumentPolicy | null | undefined,
): string {
  const label = ticketType?.documentLabel?.trim();
  return label && label.length > 0 ? label : DEFAULT_DOCUMENT_LABEL;
}

/** Organizer instructions, or null when they wrote none (render nothing). */
export function supportingDocumentInstructions(
  ticketType: SupportingDocumentPolicy | null | undefined,
): string | null {
  const text = ticketType?.documentInstructions?.trim();
  return text && text.length > 0 ? text : null;
}

// ── Upload contract ─────────────────────────────────────────────────────────

export const SUPPORTING_DOCUMENT_MAX_SIZE = 5 * 1024 * 1024;

/** Accept attribute for the file input, and the MIME allow-list on the server. */
export const SUPPORTING_DOCUMENT_ACCEPT = "application/pdf,image/jpeg,image/png";

/**
 * Where an accepted upload lands. Files are served ONLY through the authed
 * staff route: the document carries a named person, their employer and may
 * carry a signature, so the public `/uploads` catch-all blocks this prefix.
 *
 * The `resident-letters` segment is HISTORICAL and deliberately kept when this
 * generalised on 2026-08-13. Moving it would mean both validators accepting
 * two prefixes for the lifetime of the existing rows, and the prune job
 * sweeping two directories — a half-migrated private-file namespace is a
 * genuinely bad thing to own for a path no organizer ever sees.
 */
export const SUPPORTING_DOCUMENT_PATH_PREFIX = "/uploads/resident-letters/";

/**
 * Is this a path our own upload route produced?
 *
 * The registration POST takes this value from the CLIENT, so it is attacker
 * controlled. Without this check a crafted request could store any string —
 * `../../../etc/passwd`, or a path pointing at another event's private
 * directory — and the staff download route would later resolve it. Validating
 * the shape on the way IN means the read side never has to trust the column;
 * it is checked again on the way OUT because a column that has been correct
 * for a year is still not a thing to hand to `readFile`.
 */
export function isSupportingDocumentPath(url: string): boolean {
  return (
    url.startsWith(SUPPORTING_DOCUMENT_PATH_PREFIX) &&
    !url.includes("..") &&
    !url.includes("\0") &&
    // uploads/resident-letters/{eventId}/{uuid}.{ext} and nothing deeper
    /^\/uploads\/resident-letters\/[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(pdf|jpg|png)$/.test(url)
  );
}
