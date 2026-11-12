/**
 * The result line of a bulk reviewer change, in words (Nov 12, 2026).
 *
 * The server answers with counts and, for every pair it left alone, a reason
 * code and two ids. This turns that into what the organiser reads: how many
 * were assigned, how many already were, and WHICH abstracts were skipped and
 * why. Shared by the selection dialog and the pasted-sheet dialog so the two
 * cannot word the same skip differently.
 *
 * Pure and client-safe.
 */
import { formatAbstractSerial } from "@/lib/abstract-serial";

export type BulkReviewerSkipReason =
  | "ABSTRACT_NOT_FOUND"
  | "NOT_ON_POOL"
  | "NOT_REVIEWABLE"
  | "OWN_ABSTRACT"
  | "HAS_REVIEW";

/** A pair the server left alone. THE client-side shape: the hooks in use-api.ts use this type too. */
export interface BulkReviewerSkipRow {
  abstractId: string;
  reviewerUserId: string;
  reason: BulkReviewerSkipReason;
}

/** What the wording needs to name an abstract and a reviewer. */
export interface OutcomeLookups {
  abstractSerial: (abstractId: string) => number | null | undefined;
  reviewerName: (userId: string) => string | undefined;
}

export interface SkipLine {
  /** A reason code. One the page does not know yet is still shown, under its code. */
  reason: string;
  /** Why, as a sentence opener: "Their own abstract". */
  label: string;
  /** Pairs skipped for this reason. */
  count: number;
  /** What was skipped, named: "A-012 (Aisha Rahman)". Capped; `more` counts the rest. */
  items: string[];
  more: number;
}

const REASON_LABEL: Record<BulkReviewerSkipReason, string> = {
  NOT_REVIEWABLE: "Not open for review (a draft, withdrawn or already decided)",
  OWN_ABSTRACT: "Their own abstract",
  NOT_ON_POOL: "Not on this event's reviewer pool",
  ABSTRACT_NOT_FOUND: "No longer on this event",
  HAS_REVIEW: "Review already submitted, so the assignment was kept",
};

/** The order the reasons are listed in: the ones an organiser can act on first. */
const REASON_ORDER: BulkReviewerSkipReason[] = ["OWN_ABSTRACT", "HAS_REVIEW", "NOT_REVIEWABLE", "NOT_ON_POOL", "ABSTRACT_NOT_FOUND"];

const MAX_ITEMS_PER_REASON = 40;

/**
 * How one skipped pair is named under its reason. A reason about the ABSTRACT
 * names only the abstract (once, however many reviewers it was skipped for);
 * a reason about the PERSON names only the person; a reason about the pair
 * names both.
 */
function skipItem(row: BulkReviewerSkipRow, lookups: OutcomeLookups): string {
  const abstract = formatAbstractSerial(lookups.abstractSerial(row.abstractId));
  const reviewer = lookups.reviewerName(row.reviewerUserId) ?? "a reviewer";
  if (row.reason === "NOT_REVIEWABLE" || row.reason === "ABSTRACT_NOT_FOUND") return abstract;
  if (row.reason === "NOT_ON_POOL") return reviewer;
  return `${abstract} (${reviewer})`;
}

/**
 * The skipped pairs as one line per reason, each naming what it covers. A
 * reason the server sends that this page does not know yet (a newer server, an
 * older tab) gets a line under its code: "4 skipped" must never go unexplained.
 */
export function describeBulkReviewerSkips(skipped: BulkReviewerSkipRow[], lookups: OutcomeLookups): SkipLine[] {
  const known = new Set<string>(REASON_ORDER);
  const unknown = Array.from(new Set(skipped.map((row) => row.reason as string).filter((reason) => !known.has(reason))));
  const lines: SkipLine[] = [];
  for (const reason of [...REASON_ORDER, ...unknown]) {
    const rows = skipped.filter((row) => row.reason === reason);
    if (rows.length === 0) continue;
    const named = Array.from(new Set(rows.map((row) => skipItem(row, lookups)))).sort((a, b) => a.localeCompare(b));
    lines.push({
      reason,
      label: REASON_LABEL[reason as BulkReviewerSkipReason] ?? `Not done (${reason})`,
      count: rows.length,
      items: named.slice(0, MAX_ITEMS_PER_REASON),
      more: Math.max(0, named.length - MAX_ITEMS_PER_REASON),
    });
  }
  return lines;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "340 new assignments. 6 were already assigned. 4 skipped." */
export function assignHeadline(result: { assigned: number; alreadyAssigned: number; skipped: unknown[] }): string {
  const parts = [`${plural(result.assigned, "new assignment", "new assignments")}.`];
  if (result.alreadyAssigned > 0) parts.push(`${plural(result.alreadyAssigned, "was", "were")} already assigned.`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped.`);
  return parts.join(" ");
}

/** "Removed 12 assignments. 3 were not assigned. 1 kept." */
export function unassignHeadline(result: { removed: number; notAssigned: number; skipped: unknown[] }): string {
  const parts = [`Removed ${plural(result.removed, "assignment", "assignments")}.`];
  if (result.notAssigned > 0) parts.push(`${plural(result.notAssigned, "was", "were")} not assigned in the first place.`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} kept.`);
  return parts.join(" ");
}
