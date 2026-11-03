/**
 * Filling the weekend between two pieces of the same leave.
 *
 * Owner, Nov 3 2026: annual and maternity leave that continue from a Friday to
 * the Monday after are one absence, and the weekend between them is charged.
 * A dragged range already charges the weekends INSIDE it
 * (`rangeCoversCalendarDays`); this covers the case where the two sides were
 * recorded separately, Friday on one save and Monday on the next, which left
 * the weekend unrecorded and the count short (Anisha's maternity leave: 21
 * recorded days for a 29-day absence).
 *
 * Pure, so the rule is testable without a database: the service supplies what
 * is recorded around the range and which days are non-working.
 */

import { type CalendarDate, addDays } from "./hr-date";

/**
 * How far either side of a range to look. A weekend plus the longest UAE
 * public-holiday break (Eid, up to five weekdays) is nine days.
 */
export const BRIDGE_SCAN_DAYS = 10;

export function bridgeDays(params: {
  from: CalendarDate;
  to: CalendarDate;
  /** A weekend day or a public holiday. */
  isNonWorking: (date: CalendarDate) => boolean;
  /** The code recorded on a date, or undefined when nothing is. */
  recordedCode: (date: CalendarDate) => string | undefined;
  /** The code being saved. Only the same code on the far side joins. */
  code: string;
}): CalendarDate[] {
  return [...side(params, -1), ...side(params, 1)].sort();
}

/**
 * The non-working days on one side, when the run of them ends at the same
 * code. Nothing when any of them already holds a record: somebody who did
 * on-duty work that Saturday was not on leave, and a recorded day is never
 * overwritten by inference.
 */
function side(
  params: Parameters<typeof bridgeDays>[0],
  step: -1 | 1,
): CalendarDate[] {
  const gap: CalendarDate[] = [];
  let d = addDays(step < 0 ? params.from : params.to, step);
  for (let i = 0; i < BRIDGE_SCAN_DAYS; i++, d = addDays(d, step)) {
    if (params.recordedCode(d) !== undefined) {
      return gap.length > 0 && params.recordedCode(d) === params.code ? gap : [];
    }
    if (!params.isNonWorking(d)) return [];
    gap.push(d);
  }
  return [];
}
