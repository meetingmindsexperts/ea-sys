/**
 * An abstract's two presentation types (owner, Nov 19, 2026: "we need it for
 * records").
 *
 *   - `requestedPresentationType`: what the AUTHOR asked for on the submission
 *     form. The record; an organiser never changes it.
 *   - `presentationType`: the DECISION, what the organiser has the author
 *     present. It starts as the request and is what every screen, email,
 *     filter and the agenda read.
 *
 * Every write of an abstract's type goes through one of the two functions
 * below. Until Nov 19, 2026 there was one column and an organiser's choice
 * overwrote the author's.
 */
/** A key of the organisation's presentation types (abstract-presentation-types.ts); text since Nov 24, 2026. */
type PresentationType = string;

type TypeColumns = {
  presentationType: PresentationType | null;
  requestedPresentationType: PresentationType | null;
};

/**
 * The author's choice: at submission (any create, an import included) and the
 * author's own edits. Sets the request and the decision together.
 */
export function authorTypeWrite(next: PresentationType | null): TypeColumns {
  return { presentationType: next, requestedPresentationType: next };
}

/**
 * The organiser's choice: the decision only. The request is never named, so
 * an abstract whose author never chose a type keeps no request at all; a row
 * an older image wrote during the deploy is filled once afterwards (ROADMAP,
 * "Abstract requested type"), never guessed here: a guess would record an
 * organiser's earlier choice as the author's.
 */
export function organiserTypeWrite(next: PresentationType | null): { presentationType: PresentationType | null } {
  return { presentationType: next };
}

/**
 * The columns an edit of the abstract writes for the type it names. Nothing
 * when it names none or the type it already has (the edit page sends the type
 * on every save, and an unrelated save must never move the request). A change
 * while the abstract is still a DRAFT is the author's choice, whoever types it
 * (an organiser drafting on the author's behalf included); after submission
 * it is the organiser's decision, the same rule as Set status or type.
 */
export function editTypeWrite(
  next: PresentationType | null | undefined,
  abstract: { status: string; presentationType: PresentationType | null },
): Partial<TypeColumns> {
  if (next === undefined || next === abstract.presentationType) return {};
  if (abstract.status === "DRAFT") return authorTypeWrite(next);
  return organiserTypeWrite(next);
}
