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
 *   4. A weekend day -> OFF. A rule must not turn a Saturday into a working
 *      day; only an explicit entry (an OD) can do that.
 *   5. A STANDING RULE -> its code. "Everyone remote, 2 to 6 March" and "Jinan
 *      works remotely" are single records that speak for many days, so the day
 *      they describe is derived here rather than stored 252 times. See
 *      `attendance-rules.ts` for why EMPLOYEE scope beats ORG.
 *   6. Otherwise -> P.
 *
 * KNOWN AND ACCEPTED: a derived P means "nobody wrote anything down", which is
 * usually but not always the same as "they were here". §3.4 records the
 * consequence and the deferred month-finalisation that would close it.
 */

import { type CalendarDate } from "./hr-date";
import { dayOfWeek } from "./hr-date";
import { HR_DEFAULT_WEEKEND_DAYS } from "./hr-constants";
import { isWithinEmployment } from "./hr-leave-year";
import { type AttendanceRuleLike, candidateDates, ruleFor } from "./attendance-rules";

export type DerivedStatus = "NOT_EMPLOYED" | "PH" | "OFF" | "P";

export interface EffectiveStatus {
  date: CalendarDate;
  /** The leave code in force: an explicit entry's code, or a derived one. */
  code: string;
  /** True when no row exists and the code was worked out rather than recorded. */
  derived: boolean;
  /**
   * Set when a standing rule produced this day. Lets a caller tell "a rule put
   * this here" apart from "nobody wrote anything down", which the grid draws
   * differently and the balance engine counts, and which are otherwise
   * indistinguishable from the code alone.
   */
  ruleId?: string;
}

export interface EffectiveStatusContext {
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null };
  /** Explicit entries, keyed by date. One per day (the DB enforces it). */
  entriesByDate: ReadonlyMap<CalendarDate, { code: string }>;
  /** Public holiday dates for the org. */
  holidays: ReadonlySet<CalendarDate>;
  /**
   * Standing rules visible to this employee. Passing every rule in the org is
   * correct and expected: `ruleFor` filters an EMPLOYEE-scoped rule to its own
   * person, so a caller cannot leak one person's arrangement onto another by
   * forgetting to pre-filter.
   */
  rules?: readonly AttendanceRuleLike[];
  /** Needed only to resolve rules; ignored when there are none. */
  employeeId?: string;
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
  if (ctx.rules?.length && ctx.employeeId) {
    const rule = ruleFor(ctx.employeeId, date, ctx.rules);
    if (rule) return { date, code: rule.code, derived: true, ruleId: rule.id };
  }
  return { date, code: "P", derived: true };
}

/**
 * The days a standing rule actually speaks for, within a window.
 *
 * THIS IS WHAT KEEPS THE BALANCE HONEST. A rule can carry any leave code, so a
 * company-wide shutdown recorded as AL has to reach the balance engine. If it
 * did not, one record would quietly give twenty-three people free annual leave
 * and every balance in the org would be wrong with nothing on screen to show it.
 *
 * It resolves through `effectiveStatusFor`, so the days it returns are exactly
 * the days the grid draws from a rule — explicit entries, holidays and weekends
 * excluded by the same precedence, not by a second copy of it.
 *
 * Bounded by `candidateDates` rather than by the employment window: walking
 * every day since 2010 for a long-serving employee is ~5,800 iterations per
 * person, and a day no rule covers cannot be changed by one.
 */
export function ruleDerivedDays(params: {
  employeeId: string;
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null };
  rules: readonly AttendanceRuleLike[];
  /** Dates that already have a row. They win, so they are never emitted here. */
  explicitDates: ReadonlySet<CalendarDate>;
  holidays: ReadonlySet<CalendarDate>;
  from: CalendarDate;
  to: CalendarDate;
  weekendDays?: readonly number[];
}): { date: CalendarDate; ruleId: string; code: string }[] {
  if (params.rules.length === 0) return [];
  const entriesByDate = new Map<CalendarDate, { code: string }>();
  for (const date of params.explicitDates) entriesByDate.set(date, { code: "" });

  const out: { date: CalendarDate; ruleId: string; code: string }[] = [];
  for (const date of candidateDates(params.rules, params.employeeId, params.from, params.to)) {
    const status = effectiveStatusFor(date, {
      employment: params.employment,
      entriesByDate,
      holidays: params.holidays,
      rules: params.rules,
      employeeId: params.employeeId,
      weekendDays: params.weekendDays,
    });
    if (status.ruleId) out.push({ date, ruleId: status.ruleId, code: status.code });
  }
  return out;
}
