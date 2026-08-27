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

/**
 * Rounded to one decimal everywhere. Half days are the only fraction the module
 * admits, and a float sum of thirty 0.5s is not 15, which is why every day count
 * is a Prisma Decimal rather than a Float.
 */
export const HR_DAY_DECIMALS = 1;
