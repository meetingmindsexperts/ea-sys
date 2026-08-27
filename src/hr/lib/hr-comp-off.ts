/**
 * COMP-OFF EARNING (Art. 28 FDL 33/2021), and the one rule in this module where
 * the workbook is wrong.
 *
 * THE RULE (owner ruling, Aug 27 2026): working BOTH days of the same weekend
 * earns exactly one comp-off. A lone Saturday earns none. Two working days
 * marked OD earn none.
 *
 * WHAT THE WORKBOOK DOES INSTEAD, and why it looks right. Its formula is
 *
 *     IF(AND(F="OD", COUNTIFS(sameEmp, date-1, "OD") > 0), 1, 0)
 *
 * which asks "was yesterday also OD", not "were both weekend days worked". The
 * two agree on every Sat+Sun pair, which is the overwhelming majority of the
 * data, so the difference is invisible until something else happens. In the live
 * v5.1 data exactly one row diverges: EMP002 worked Wed 14 and Thu 15 January
 * 2026 and was credited a comp-off that this rule does not award. The import
 * therefore reports one expected variance rather than treating it as a failure
 * (docs/HR_MODULE_PLAN.md §13.1).
 *
 * The previous-day rule also compounds: a three-day run earns two under it and
 * one here, which is precisely the case the owner was asked about.
 *
 * GENERALISED OVER THE WEEKEND CONFIGURATION rather than hardcoded to Sat+Sun,
 * because some GCC entities run Friday and Saturday. A weekend BLOCK is a
 * maximal run of consecutive weekend days; a block earns one comp-off when every
 * day in it is OD. That reduces to the ruling for a two-day weekend and stays
 * sensible for a one-day or three-day one.
 *
 * The balance is always DERIVED from entries, never stored as a counter, so it
 * cannot drift away from the days that justify it.
 */

import { type CalendarDate, addDays } from "./hr-date";
import { dayOfWeek } from "./hr-date";
import { HR_DEFAULT_WEEKEND_DAYS } from "./hr-constants";

export interface CompOffInput {
  /** Dates the employee was marked OD. Order does not matter; duplicates are ignored. */
  onDutyDates: readonly CalendarDate[];
  /** `getUTCDay()` values that count as weekend. Defaults to Saturday and Sunday. */
  weekendDays?: readonly number[];
}

export interface CompOffEarning {
  /** The weekend block that earned it, first day to last day. */
  from: CalendarDate;
  to: CalendarDate;
}

function isWeekendDay(date: CalendarDate, weekendDays: readonly number[]): boolean {
  return weekendDays.includes(dayOfWeek(date));
}

/**
 * The weekend block containing `date`: walk outwards while the neighbouring days
 * are also weekend days. For a Sat+Sun weekend this returns the pair; for a
 * single-day weekend it returns that day alone.
 */
function weekendBlockContaining(
  date: CalendarDate,
  weekendDays: readonly number[],
): CalendarDate[] {
  const block: CalendarDate[] = [date];
  for (let d = addDays(date, -1); isWeekendDay(d, weekendDays); d = addDays(d, -1)) {
    block.unshift(d);
  }
  for (let d = addDays(date, 1); isWeekendDay(d, weekendDays); d = addDays(d, 1)) {
    block.push(d);
  }
  return block;
}

/**
 * Every comp-off earned by these OD days, one entry per fully-worked weekend.
 *
 * Returns the blocks rather than a bare count so the UI can say WHICH weekend
 * earned a day. "You have 3 comp-offs" is a number; "17-18 Jan, 14-15 Feb" is an
 * answer.
 */
export function compOffEarnings(input: CompOffInput): CompOffEarning[] {
  const weekendDays = input.weekendDays ?? HR_DEFAULT_WEEKEND_DAYS;
  if (weekendDays.length === 0) return [];

  const od = new Set(input.onDutyDates);
  const seenBlocks = new Set<CalendarDate>();
  const earned: CompOffEarning[] = [];

  for (const date of [...od].sort()) {
    if (!isWeekendDay(date, weekendDays)) continue;
    const block = weekendBlockContaining(date, weekendDays);
    const key = block[0];
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    // Every day of the weekend must have been worked. A weekend half-worked is
    // a weekend not given back.
    if (block.every((d) => od.has(d))) {
      earned.push({ from: block[0], to: block[block.length - 1] });
    }
  }
  return earned;
}

/**
 * How many comp-offs these OD days earned.
 *
 * A block is attributed to the leave year of its LAST day, which is the day the
 * entitlement completes. That only matters for a weekend straddling New Year,
 * and comp-off is a running balance rather than an annual one, so it is a
 * consistency rule rather than a policy.
 */
export function countCompOffEarned(input: CompOffInput): number {
  return compOffEarnings(input).length;
}
