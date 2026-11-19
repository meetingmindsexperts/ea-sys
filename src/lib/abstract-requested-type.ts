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
import type { PresentationType } from "@prisma/client";

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
 * The organiser's choice: the decision only. A row whose request was never
 * recorded (written by an older image during a deploy) keeps the type it had
 * as the request first, so the author's choice is not lost there either.
 */
export function organiserTypeWrite(
  next: PresentationType | null,
  current: TypeColumns,
): { presentationType: PresentationType | null; requestedPresentationType?: PresentationType } {
  const keep = current.requestedPresentationType === null ? current.presentationType : null;
  return { presentationType: next, ...(keep !== null && { requestedPresentationType: keep }) };
}

/**
 * Whose choice an edit of the abstract is. Until it is submitted the abstract
 * is the author's draft, whoever types into it (an organiser drafting on the
 * author's behalf included); after that, only the author's own account.
 */
export function editIsTheAuthors(abstract: { status: string; speaker: { userId: string | null } | null }, userId: string): boolean {
  if (abstract.status === "DRAFT") return true;
  return !!abstract.speaker?.userId && abstract.speaker.userId === userId;
}

/**
 * The columns an edit of the abstract writes for the type it names: nothing
 * when it names none, the author's choice or the organiser's otherwise.
 */
export function editTypeWrite(
  next: PresentationType | null | undefined,
  abstract: TypeColumns & { status: string; speaker: { userId: string | null } | null },
  userId: string,
): Partial<TypeColumns> {
  if (next === undefined) return {};
  if (editIsTheAuthors(abstract, userId)) return authorTypeWrite(next);
  return organiserTypeWrite(next, abstract);
}
