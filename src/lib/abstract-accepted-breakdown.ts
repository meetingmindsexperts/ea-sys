/**
 * The Accepted card on the Abstracts page, split by presentation type (owner,
 * Nov 20, 2026: "how many accepted as oral and how many accepted as poster").
 *
 * Every type with at least one accepted abstract is listed, in the order the
 * type picker shows them, and accepted abstracts with no type yet are counted
 * as their own entry, so the parts always add up to the card's number: a
 * card that said "12 accepted: Oral 5, Poster 4" would leave three unexplained.
 *
 * Client-safe: a pure count over the rows the page already holds.
 */
import { PRESENTATION_TYPE_LABELS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

export const NO_PRESENTATION_TYPE_LABEL = "No type yet";

export interface AcceptedTypeCount {
  /** The presentation type, or null for accepted abstracts with none decided. */
  type: string | null;
  label: string;
  count: number;
}

export function acceptedByPresentationType(
  abstracts: ReadonlyArray<{ status: string; presentationType: string | null }>,
): AcceptedTypeCount[] {
  const counts = new Map<string | null, number>();
  for (const a of abstracts) {
    if (a.status !== "ACCEPTED") continue;
    const type = a.presentationType || null;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const known = Object.keys(PRESENTATION_TYPE_LABELS);
  const labels: Record<string, string> = PRESENTATION_TYPE_LABELS;
  const out: AcceptedTypeCount[] = [];
  for (const type of known) {
    const count = counts.get(type);
    if (count) out.push({ type, label: labels[type], count });
  }
  // A type this build does not know (an older row, a later enum value): still counted, under its own name.
  for (const [type, count] of counts) {
    if (type !== null && !known.includes(type)) out.push({ type, label: type, count });
  }
  const untyped = counts.get(null);
  if (untyped) out.push({ type: null, label: NO_PRESENTATION_TYPE_LABEL, count: untyped });
  return out;
}
