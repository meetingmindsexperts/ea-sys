/**
 * What one bulk status or type change came to, in the words the dialog shows
 * (Nov 19, 2026). Pure, so the wording is tested without a screen.
 *
 * It NAMES the abstracts that were skipped, by reason: "4 were skipped" leaves
 * an organiser with 165 rows to hunt through.
 */
export interface BulkUpdateSkip {
  abstractId: string;
  code: string;
}

export interface BulkUpdateTotals {
  changed: string[];
  unchanged: string[];
  skipped: BulkUpdateSkip[];
  remaining: string[];
  emailed: number;
  emailFailed: number;
  interrupted: string | null;
}

export interface BulkUpdateReport {
  /** "error" when something asked for did not happen; the dialog colours by it. */
  level: "success" | "warning";
  headline: string;
  lines: string[];
}

const SKIP_REASONS: Record<string, string> = {
  INSUFFICIENT_REVIEWS: "Not enough scored reviews yet",
  ABSTRACT_WITHDRAWN: "Withdrawn, which cannot be undone",
  NOT_SUBMITTED: "Still a draft: the author has not submitted it",
  STATUS_CHANGED: "Changed by someone else at the same moment",
  NOT_FOUND: "No longer on this event",
};
const OTHER_REASON = "Could not be changed";

/** Enough numbers to act on without a list that fills the dialog. */
const MAX_NUMBERS = 30;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function numberList(ids: string[], numberOf: (id: string) => string): string {
  const numbers = ids.map(numberOf);
  if (numbers.length <= MAX_NUMBERS) return numbers.join(", ");
  return `${numbers.slice(0, MAX_NUMBERS).join(", ")} and ${numbers.length - MAX_NUMBERS} more`;
}

export function describeBulkUpdate(totals: BulkUpdateTotals, numberOf: (id: string) => string): BulkUpdateReport {
  const lines: string[] = [];
  if (totals.unchanged.length > 0) {
    lines.push(`${plural(totals.unchanged.length, "was", "were")} already as chosen, so nothing changed for ${totals.unchanged.length === 1 ? "it" : "them"}.`);
  }

  // One line per reason, in the order the reasons first appeared.
  const byReason = new Map<string, string[]>();
  for (const skip of totals.skipped) {
    const reason = SKIP_REASONS[skip.code] ?? OTHER_REASON;
    byReason.set(reason, [...(byReason.get(reason) ?? []), skip.abstractId]);
  }
  for (const [reason, ids] of byReason) {
    lines.push(`${reason} (${ids.length}): ${numberList(ids, numberOf)}`);
  }

  if (totals.emailed > 0) lines.push(`${plural(totals.emailed, "author was", "authors were")} emailed the decision.`);
  if (totals.emailFailed > 0) {
    lines.push(`${plural(totals.emailFailed, "decision email", "decision emails")} could not be sent. The status changed all the same: resend from Communications.`);
  }
  if (totals.interrupted) {
    lines.push(`The change stopped before the end (${totals.interrupted}). ${plural(totals.remaining.length, "abstract was", "abstracts were")} not reached.`);
  }

  const attention = totals.skipped.length > 0 || totals.emailFailed > 0 || !!totals.interrupted;
  return {
    level: attention ? "warning" : "success",
    headline: totals.changed.length > 0 ? `${plural(totals.changed.length, "abstract", "abstracts")} updated` : "Nothing was changed",
    lines,
  };
}

/** The ids still worth having ticked afterwards: what was skipped and what was not reached. */
export function unfinishedIds(totals: BulkUpdateTotals): string[] {
  return [...totals.skipped.map((s) => s.abstractId), ...totals.remaining];
}
