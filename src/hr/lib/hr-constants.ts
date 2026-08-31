import type { LeaveCategory } from "@prisma/client";

/**
 * HR module constants. Client-safe: no `db`, no Node built-ins, so the settings
 * UI and the balance engine can share one definition rather than two that drift.
 */

/**
 * Annual leave granted for a full leave year, once the employee has completed
 * twelve months. Flat, not accrued monthly: read from the workbook's own
 * formula, `IF(EDATE(joining,12) <= TODAY(), 30, 0)`.
 */
export const HR_ANNUAL_ENTITLEMENT_DAYS = 30;

/**
 * Ceiling on annual-leave days carried into the next leave year (owner,
 * Aug 27 2026).
 *
 * The cap applies to a POSITIVE carryover only. A NEGATIVE balance carries in
 * full and is never floored, because a cap on a debt would forgive it, and the
 * same owner ruling says leave taken in advance follows the employee into the
 * new year. Capping both directions would quietly cancel that.
 */
export const HR_CARRYOVER_CAP_DAYS = 30;

/**
 * Art. 31 FDL 33/2021 sick-leave tiers, per leave year: 15 days at full pay,
 * then 30 at half pay, then 45 unpaid.
 */
export const HR_SICK_TIER_DAYS = { full: 15, half: 30, unpaid: 45 } as const;

/**
 * Default weekend, as JS `getUTCDay()` values: Saturday and Sunday. Per-org
 * configurable, because some GCC entities run Friday and Saturday.
 */
export const HR_DEFAULT_WEEKEND_DAYS: readonly number[] = [6, 0];

/** The org's own working week. HR reads dates in the week its people work. */
export const HR_DEFAULT_TIMEZONE = "Asia/Dubai";

/**
 * Rounded to one decimal everywhere. Half days are the only fraction the module
 * admits, and a float sum of thirty 0.5s is not 15, which is why every day count
 * is a Prisma Decimal rather than a Float.
 */
export const HR_DAY_DECIMALS = 1;

/**
 * Does a recorded RANGE cover calendar days, or only working days?
 *
 * Owner ruling, Aug 31 2026, taken from the workbook rather than from a
 * principle: a holiday booked Monday the 6th to Friday the 17th costs TWELVE
 * days, not ten. The weekend in the middle is charged, because the person was
 * away. That is what the Excel did and what every imported balance was
 * calculated from, so matching it keeps new records consistent with history
 * instead of quietly cheaper.
 *
 * The scope is annual leave specifically, and the data is what decided that:
 * of the imported rows, 86 of 419 ANNUAL days fall on a weekend, while only 2
 * of 45 sick days do. So the Excel charged annual leave across a block and
 * recorded sick leave on working days only. Applying the calendar rule to sick
 * leave would have invented a policy nobody has.
 *
 * ON_DUTY and COMP_OFF are here for a different reason: those codes describe
 * the DAY ITSELF rather than an absence from it, so a Saturday is exactly when
 * they are meant to be recorded.
 */
export function rangeCoversCalendarDays(category: LeaveCategory): boolean {
  return category === "ANNUAL" || category === "ON_DUTY" || category === "COMP_OFF";
}

/**
 * Does a category describe WORKING, or time not worked?
 *
 * Decides which standing rule speaks when two overlap (`ruleFor`). Owner
 * ruling, Aug 31 2026 (review M9): "the shutdown wins". A company-wide rule
 * that puts everyone on leave puts the permanently remote person on leave too,
 * and charges her for it; her standing WFH arrangement resumes when the
 * shutdown ends; and a leave day recorded for her personally still overrides
 * the arrangement, as any explicit entry does. So time not worked outranks a
 * working arrangement whatever the scope, and the narrower-statement order
 * (EMPLOYEE over ORG) decides only between two rules of the same kind.
 *
 * WORK and ON_DUTY are the working categories: P and WFH, and OD, which
 * describes a day that was worked. Everything else, leave, rest and holiday
 * alike, is time not worked.
 */
export function isWorkingCategory(category: LeaveCategory): boolean {
  return category === "WORK" || category === "ON_DUTY";
}
