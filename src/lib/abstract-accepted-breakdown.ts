/**
 * The Accepted card on the Abstracts page, split by presentation type (owner,
 * Nov 20, 2026: "how many accepted as oral and how many accepted as poster").
 *
 * Every type with at least one accepted abstract is listed, Oral and Poster
 * first (`inDecisionOrder`, which a test pins), and
 * accepted abstracts with no type at all are counted as their own entry, so
 * the parts always add up to the card's number: a card that said "12
 * accepted: Oral 5, Poster 4" would leave three unexplained.
 *
 * It counts `presentationType`, the organiser's decision, which STARTS as what
 * the author asked for (abstract-requested-type.ts). So an abstract accepted
 * without anyone setting its type is counted under the author's request, and
 * "Oral or Poster" is, in practice, the accepted abstracts still to be decided
 * one way or the other. "No type yet" is rare: a type is required to submit.
 *
 * Client-safe: a pure count over the rows the page already holds.
 */
import { inDecisionOrder, type PresentationTypeDef } from "@/lib/abstract-presentation-types";

export const NO_PRESENTATION_TYPE_LABEL = "No type yet";

export interface AcceptedTypeCount {
  /** The presentation type, or null for accepted abstracts with none decided. */
  type: string | null;
  label: string;
  count: number;
}

export function acceptedByPresentationType(
  abstracts: ReadonlyArray<{ status: string; presentationType: string | null }>,
  types: readonly PresentationTypeDef[],
): AcceptedTypeCount[] {
  const counts = new Map<string | null, number>();
  for (const a of abstracts) {
    if (a.status !== "ACCEPTED") continue;
    const type = a.presentationType || null;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const known = types.map((t) => t.key);
  const out: AcceptedTypeCount[] = [];
  for (const type of inDecisionOrder(types)) {
    const count = counts.get(type.key);
    if (count) out.push({ type: type.key, label: type.label, count });
  }
  // A type the list does not know (deleted, or written by hand): still counted, under its own name.
  for (const [type, count] of counts) {
    if (type !== null && !known.includes(type)) out.push({ type, label: type, count });
  }
  const untyped = counts.get(null);
  if (untyped) out.push({ type: null, label: NO_PRESENTATION_TYPE_LABEL, count: untyped });
  return out;
}
