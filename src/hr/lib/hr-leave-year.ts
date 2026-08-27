/**
 * LEAVE YEAR and the employment anniversary.
 *
 * The leave year is the CALENDAR year, read from the workbook's own formulas
 * (docs/HR_MODULE_PLAN.md §3.1): entitlement is `IF(EDATE(joining,12) <= TODAY(),
 * 30, 0)` and the annual-leave COUNTIFS has no lower date bound over a sheet
 * spanning exactly one year. So nothing accumulates across years inside the
 * ledger; last year arrives as a carried-in figure.
 *
 * The anniversary survives in exactly two places: the first-year eligibility
 * gate, and the "next anniversary" shown to HR. Both live here, and both are
 * called rather than re-derived, because the 29 February case has to resolve the
 * same way for every caller (see `anniversaryOn`).
 */

import { type CalendarDate, isWithin, yearOf } from "./hr-date";

/** First and last day of a leave year, inclusive. */
export function leaveYearBounds(year: number): { from: CalendarDate; to: CalendarDate } {
  const y = String(year).padStart(4, "0");
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/**
 * The employment anniversary falling in `year`.
 *
 * THE 29 FEBRUARY CASE, and why it is decided here once. Someone who joined on
 * 29 February has no anniversary in three years out of four. Postgres, JS
 * `Date` and a human all resolve that differently if left to themselves, and two
 * call sites disagreeing about whether the entitlement lands on 28 February or
 * 1 March is a defect nobody finds until the year it matters.
 *
 * The ruling: **28 February**, the last day of the same month. It is the earlier
 * of the two candidates, which means the employee is never made to wait an extra
 * day for an entitlement they have earned, and it keeps the anniversary inside
 * the month people think of it as belonging to.
 */
export function anniversaryOn(joiningDate: CalendarDate, year: number): CalendarDate {
  const month = Number(joiningDate.slice(5, 7));
  const day = Number(joiningDate.slice(8, 10));
  // Clamp to the last real day of the intended month rather than letting
  // `Date.UTC` roll 29 February over into March. Clamping is exact for every
  // input; stepping back a day from the rolled-over value is only exact because
  // the overflow happens to be one day, which is the kind of reasoning that
  // stops being true the first time somebody changes the surrounding code.
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDayOfMonth);
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(safeDay).padStart(2, "0"),
  ].join("-");
}

/**
 * Has the employee completed twelve months as at `asOf`?
 *
 * This is the entitlement gate, and it MOVES: an employee sits at zero
 * entitlement, possibly with a negative balance, until the day their first
 * anniversary passes, at which point 30 days appear with nobody having edited
 * anything. EMP021 is the live case (-23 today, +7 the day after). The UI has to
 * make that legible rather than let it read as a correction nobody made.
 */
export function hasCompletedFirstYear(
  joiningDate: CalendarDate,
  asOf: CalendarDate,
): boolean {
  return asOf >= anniversaryOn(joiningDate, yearOf(joiningDate) + 1);
}

/** The next anniversary strictly after `asOf`. Informational after year one. */
export function nextAnniversary(
  joiningDate: CalendarDate,
  asOf: CalendarDate,
): CalendarDate {
  let year = yearOf(asOf);
  let candidate = anniversaryOn(joiningDate, year);
  while (candidate <= asOf) candidate = anniversaryOn(joiningDate, ++year);
  return candidate;
}

/**
 * Is this date inside the employment window? The exit date is the last working
 * day and is INCLUSIVE, which is the one thing about it that is easy to get
 * wrong: an exclusive reading silently drops the leave somebody took on their
 * final day.
 */
export function isWithinEmployment(
  date: CalendarDate,
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null },
): boolean {
  return isWithin(date, employment.joiningDate, employment.exitDate ?? null);
}

/**
 * The part of a leave year this employee was actually employed for. Used to
 * bound every query, so an exit in August cannot pick up September rows and a
 * joiner in March is not judged against January.
 */
export function employedWindowInYear(
  year: number,
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null },
): { from: CalendarDate; to: CalendarDate } | null {
  const { from, to } = leaveYearBounds(year);
  const start = employment.joiningDate > from ? employment.joiningDate : from;
  const end = employment.exitDate && employment.exitDate < to ? employment.exitDate : to;
  if (start > end) return null;
  return { from: start, to: end };
}
