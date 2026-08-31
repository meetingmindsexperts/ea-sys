/**
 * STANDING RULES: which one, if any, speaks for a given (employee, day).
 *
 * Pure. No database, no dates-as-instants, no knowledge of weekends or public
 * holidays — that ordering lives in `hr-effective-status.ts` and must stay in
 * one place, because the grid and the balance engine both read it and a second
 * copy would eventually disagree about somebody's pay.
 *
 * WHY RULES EXIST AT ALL, from the imported data rather than intuition: 252 of
 * 386 work-from-home days are twelve company-wide dates, 120 more belong to one
 * permanently remote employee, and only 14 are one-offs. The stored rows were
 * fourteen times the information they carried.
 */

import { type CalendarDate, isWithin } from "./hr-date";

export type AttendanceRuleScope = "ORG" | "EMPLOYEE";

/** A rule reduced to what the resolution needs. */
export interface AttendanceRuleLike {
  id: string;
  scope: AttendanceRuleScope;
  /** Set when scope is EMPLOYEE. */
  employeeId?: string | null;
  code: string;
  startDate: CalendarDate;
  /** Null means open-ended: it holds until somebody ends it. */
  endDate?: CalendarDate | null;
}

/** Does this rule address this person on this date at all? */
export function ruleApplies(
  rule: AttendanceRuleLike,
  employeeId: string,
  date: CalendarDate,
): boolean {
  if (rule.scope === "EMPLOYEE" && rule.employeeId !== employeeId) return false;
  return isWithin(date, rule.startDate, rule.endDate ?? null);
}

/**
 * The rule in force, or null.
 *
 * Precedence, and both halves are deliberate:
 *
 *   1. EMPLOYEE beats ORG. "Jinan works remotely" is a narrower statement than
 *      "the office is closed", so it is the one that should win when they
 *      disagree. Without this an org-wide rule would silently overwrite every
 *      individual arrangement for its duration.
 *   2. Within a scope, the LATER start date wins, with the id as a stable
 *      tiebreak. Two overlapping rules of the same scope are a genuine
 *      ambiguity; resolving it by recency means the most recent decision is the
 *      one that holds, and resolving it DETERMINISTICALLY is what stops the
 *      grid and the balance engine reading the same data two ways.
 *
 * The sort is done here rather than expected from the caller on purpose: a pure
 * function whose answer depends on the order it was handed is not pure enough to
 * trust with a payroll number.
 */
export function ruleFor(
  employeeId: string,
  date: CalendarDate,
  rules: readonly AttendanceRuleLike[],
): AttendanceRuleLike | null {
  let best: AttendanceRuleLike | null = null;
  for (const rule of rules) {
    if (!ruleApplies(rule, employeeId, date)) continue;
    if (!best) { best = rule; continue; }
    if (beats(rule, best)) best = rule;
  }
  return best;
}

function beats(a: AttendanceRuleLike, b: AttendanceRuleLike): boolean {
  if (a.scope !== b.scope) return a.scope === "EMPLOYEE";
  if (a.startDate !== b.startDate) return a.startDate > b.startDate;
  return a.id > b.id;
}

/**
 * The dates any rule could possibly speak for, clamped to a window.
 *
 * Used to bound the balance engine's work. Walking every day of employment
 * would be ~5,800 iterations for a sixteen-year employee; walking only the rule
 * windows is a few hundred, and gives the identical answer because a day no
 * rule covers cannot be changed by one.
 */
export function candidateDates(
  rules: readonly AttendanceRuleLike[],
  employeeId: string,
  from: CalendarDate,
  to: CalendarDate,
): CalendarDate[] {
  const seen = new Set<CalendarDate>();
  for (const rule of rules) {
    if (rule.scope === "EMPLOYEE" && rule.employeeId !== employeeId) continue;
    const start = rule.startDate > from ? rule.startDate : from;
    const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
    if (start > end) continue;
    for (let d = start; d <= end; d = nextDate(d)) seen.add(d);
  }
  return [...seen].sort();
}

/** Local +1 day on the string form, so no Date object and no timezone. */
function nextDate(date: CalendarDate): CalendarDate {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return [
    String(next.getUTCFullYear()).padStart(4, "0"),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-") as CalendarDate;
}
