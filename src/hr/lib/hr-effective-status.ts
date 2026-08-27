/**
 * The EFFECTIVE STATUS of one (employee, day), including the days for which no
 * row exists.
 *
 * The module stores only the entries that carry information: 943 of the
 * workbook's 9,125 rows (docs/HR_MODULE_PLAN.md §3.4). Everything else is
 * derived here. Precedence, and each step exists because the one after it would
 * otherwise be wrong:
 *
 *   1. Outside the employment window -> NOT_EMPLOYED. Before joining and after
 *      the exit date there is nothing to say, and "Present" would be a claim
 *      about somebody who did not work here.
 *   2. An explicit entry -> that entry. This is what lets OD on a Saturday
 *      override the weekend, which is the whole point of the OD code.
 *   3. A public holiday -> PH.
 *   4. A weekend day -> OFF.
 *   5. Otherwise -> P.
 *
 * KNOWN AND ACCEPTED: a derived P means "nobody wrote anything down", which is
 * usually but not always the same as "they were here". §3.4 records the
 * consequence and the deferred month-finalisation that would close it.
 */

import { type CalendarDate } from "./hr-date";
import { dayOfWeek } from "./hr-date";
import { HR_DEFAULT_WEEKEND_DAYS } from "./hr-constants";
import { isWithinEmployment } from "./hr-leave-year";

export type DerivedStatus = "NOT_EMPLOYED" | "PH" | "OFF" | "P";

export interface EffectiveStatus {
  date: CalendarDate;
  /** The leave code in force: an explicit entry's code, or a derived one. */
  code: string;
  /** True when no row exists and the code was worked out rather than recorded. */
  derived: boolean;
}

export interface EffectiveStatusContext {
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null };
  /** Explicit entries, keyed by date. One per day (the DB enforces it). */
  entriesByDate: ReadonlyMap<CalendarDate, { code: string }>;
  /** Public holiday dates for the org. */
  holidays: ReadonlySet<CalendarDate>;
  weekendDays?: readonly number[];
}

export function effectiveStatusFor(
  date: CalendarDate,
  ctx: EffectiveStatusContext,
): EffectiveStatus {
  if (!isWithinEmployment(date, ctx.employment)) {
    return { date, code: "NOT_EMPLOYED", derived: true };
  }
  const entry = ctx.entriesByDate.get(date);
  if (entry) return { date, code: entry.code, derived: false };
  if (ctx.holidays.has(date)) return { date, code: "PH", derived: true };
  const weekendDays = ctx.weekendDays ?? HR_DEFAULT_WEEKEND_DAYS;
  if (weekendDays.includes(dayOfWeek(date))) return { date, code: "OFF", derived: true };
  return { date, code: "P", derived: true };
}
