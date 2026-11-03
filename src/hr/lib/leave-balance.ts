/**
 * THE BALANCE ENGINE. Pure functions over already-queried data, and the single
 * source of truth for every balance in the module.
 *
 * Every surface calls this: the UI, the reports, the MCP tools, the CSV export
 * and the one-time import's reconciliation gate. There is deliberately no second
 * implementation of balance maths anywhere, because two of them will disagree
 * and the disagreement will surface as a payroll figure.
 *
 * Pure on purpose: it takes rows and returns numbers, so the hard part is
 * testable against the real reconciliation baseline (docs/HR_MODULE_PLAN.md
 * §13.1) without a database.
 */

import type { LeaveCategory } from "@prisma/client";
import { type CalendarDate, addDays, dayOfWeek, isWithin } from "./hr-date";
import {
  HR_ANNUAL_ENTITLEMENT_DAYS,
  HR_CARRYOVER_CAP_DAYS,
  HR_DEFAULT_WEEKEND_DAYS,
  HR_SICK_TIER_DAYS,
} from "./hr-constants";
import {
  employedWindowInYear,
  hasCompletedFirstYear,
  nextAnniversary,
} from "./hr-leave-year";
import { type CompOffEarning, compOffEarnings } from "./hr-comp-off";

/** One attendance row, reduced to what the maths needs. */
export interface BalanceEntry {
  date: CalendarDate;
  category: LeaveCategory;
  /** 1.0, or 0.5 for a half-day code. */
  dayWeight: number;
}

export interface BalanceEmployee {
  joiningDate: CalendarDate;
  exitDate?: CalendarDate | null;
  /** As stored. Capped for display by `capCarryover`; see below. */
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
  /**
   * An agreed figure that REPLACES the standard entitlement. Null means use the
   * rule. It beats the first-year gate on purpose: this is a human decision
   * between the employee and management, and a rule should not overrule one
   * (owner ruling, Aug 31 2026 — typically a leaver, whose final year is
   * negotiated rather than calculated).
   */
  annualEntitlementDays?: number | null;
  /**
   * The leave year `carryoverDays` and `openingSickUsed` belong to. They count
   * in that year only; any other year gets its carry-in from `carriedInDays`
   * (the `LeaveGrant` the year-end roll wrote) and no opening sick figure.
   * Null means "the year asked for", so a typed figure is never silently
   * ignored on a row created by a path that forgot to stamp it.
   */
  seedLeaveYear?: number | null;
}

export interface BalanceInput {
  employee: BalanceEmployee;
  leaveYear: number;
  /** The date the balance is "as at". Drives the moving entitlement gate. */
  asOf: CalendarDate;
  /** The employee's entries. Any range: the engine bounds them itself. */
  entries: readonly BalanceEntry[];
  /**
   * What was carried into THIS leave year, when a `LeaveGrant` row records it.
   *
   * `Employee.carryoverDays` is only the SEED, for the year the record was
   * created (`seedLeaveYear`). From the first year-end roll onwards the figure
   * lives on the grant, and the seed is never overwritten. That is deliberate:
   * overwriting it would make last year's closing balance unrecomputable the
   * moment it was written, so a December leave day entered in January could
   * never be reconciled. Non-destructive means the roll can simply be
   * recomputed, which is what the worker does every night through January.
   */
  carriedInDays?: number;
  weekendDays?: readonly number[];
  /** Public holidays. Only used to join a leave spell across a holiday break. */
  holidays?: ReadonlySet<CalendarDate>;
}

export interface SickTier {
  used: number;
  limit: number;
  /** May go NEGATIVE when more days were coded to a tier than it holds. That is
   *  a real data problem (HR picked the wrong code) and is shown, not hidden. */
  remaining: number;
}

export interface LeaveBalance {
  leaveYear: number;
  asOf: CalendarDate;
  /**
   * False when the employment window and the leave year do not overlap (an
   * exit before the year, or a joining date after it). Every annual and sick
   * figure is then zero BY CONSTRUCTION, and a surface must say "not employed
   * this year" rather than render the zeros as a balance.
   */
  employedInYear: boolean;
  hasCompletedFirstYear: boolean;
  nextAnniversary: CalendarDate;
  annual: {
    entitlement: number;
    /** True when the figure came from an agreement, not from the rule. Surfaced
     *  so nobody has to wonder why one person's number differs. */
    entitlementOverridden: boolean;
    /** After the cap. */
    carriedIn: number;
    /** As stored, so a value the cap trimmed is still visible. */
    carriedInStored: number;
    taken: number;
    balance: number;
  };
  sick: { full: SickTier; half: SickTier; unpaid: SickTier };
  compOff: {
    /** OD days worked, the raw days behind `earned`. Only a fully worked
     *  weekend earns a comp-off, so this is usually more than `earned`. */
    onDutyDays: number;
    opening: number;
    earned: number;
    taken: number;
    balance: number;
    earnings: CompOffEarning[];
  };
  maternity: {
    /** Days recorded in this leave year. Working days only, as recorded. */
    taken: number;
    /** The spell `asOf` falls inside, or null when not on maternity leave then. */
    current: LeaveSpell | null;
  };
  parental: {
    /** Days recorded in this leave year (Art. 32). Working days, as recorded. */
    taken: number;
  };
}

/** A stretch of one kind of leave, start to end, and the days recorded in it. */
export interface LeaveSpell {
  from: CalendarDate;
  to: CalendarDate;
  days: number;
}

/**
 * Group one category's recorded days into spells. Exported for tests.
 *
 * Maternity covers calendar days (`rangeCoversCalendarDays`, since Nov 3 2026),
 * but anything recorded before that, or day by day on the grid, may hold no
 * rows for weekends or public holidays. Two recorded days belong to one spell
 * when every day between them is one of those. A fixed day-count gap was the
 * first version and split every spell at Eid (a five-weekday holiday is a
 * ten-day gap).
 */
export function leaveSpells(
  entries: readonly BalanceEntry[],
  category: LeaveCategory,
  nonWorking: { weekendDays?: readonly number[]; holidays?: ReadonlySet<CalendarDate> } = {},
): LeaveSpell[] {
  const weekendDays = nonWorking.weekendDays ?? HR_DEFAULT_WEEKEND_DAYS;
  const offWork = (d: CalendarDate) =>
    weekendDays.includes(dayOfWeek(d)) || (nonWorking.holidays?.has(d) ?? false);
  const onlyOffWorkBetween = (a: CalendarDate, b: CalendarDate) => {
    for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) {
      if (!offWork(d)) return false;
    }
    return true;
  };
  const days = entries
    .filter((e) => e.category === category)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const spells: LeaveSpell[] = [];
  for (const e of days) {
    const last = spells[spells.length - 1];
    if (last && onlyOffWorkBetween(last.to, e.date)) {
      last.to = e.date;
      last.days = roundDays(last.days + e.dayWeight);
      continue;
    }
    spells.push({ from: e.date, to: e.date, days: e.dayWeight });
  }
  return spells;
}

/** One decimal place everywhere. Half days are the only fraction admitted. */
export function roundDays(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Apply the carryover policy: positive days are capped, a negative carries in
 * FULL and is never floored.
 *
 * The asymmetry is the policy, not an oversight (owner, Aug 27 2026). Capping a
 * debt would forgive it, which would cancel the companion ruling that leave
 * taken in advance follows the employee into the new year. Anyone "tidying" this
 * into a symmetric clamp would silently write off every advance.
 */
export function capCarryover(days: number): number {
  return days > HR_CARRYOVER_CAP_DAYS ? HR_CARRYOVER_CAP_DAYS : roundDays(days);
}

function sumWeights(
  entries: readonly BalanceEntry[],
  category: LeaveCategory,
  from: CalendarDate | null,
  to: CalendarDate | null,
): number {
  let total = 0;
  for (const e of entries) {
    if (e.category !== category) continue;
    if (!isWithin(e.date, from, to)) continue;
    total += e.dayWeight;
  }
  return roundDays(total);
}

/** A year's entitlement: nothing outside employment, an agreement outranks the first-year gate. */
function yearEntitlement(
  employedInYear: boolean,
  overridden: boolean,
  override: number | null | undefined,
  completedFirstYear: boolean,
): number {
  if (!employedInYear) return 0;
  if (overridden) return roundDays(override as number);
  return completedFirstYear ? HR_ANNUAL_ENTITLEMENT_DAYS : 0;
}

function tier(used: number, limit: number): SickTier {
  return { used: roundDays(used), limit, remaining: roundDays(limit - used) };
}

export function computeLeaveBalance(input: BalanceInput): LeaveBalance {
  const { employee, leaveYear, asOf, entries } = input;

  // Annual and sick are bounded to the leave year AND to the employment window,
  // so an exit in August cannot pick up September rows and a joiner in March is
  // not judged against January.
  const window = employedWindowInYear(leaveYear, employee);
  const employedInYear = window !== null;
  // NO window means NOTHING to count, not "no bound". `isWithin` treats a null
  // bound as open, which is right for a rule window and wrong here: passing
  // `null, null` through summed the person's ENTIRE history against a fresh
  // entitlement, which is what the leavers view showed for anyone whose exit
  // preceded the year (review H1, Aug 31 2026). A year the person was not
  // employed in gets zeros, and `employedInYear` says why.
  const yearEntries = employedInYear ? entries : [];
  const from = window?.from ?? null;
  const to = window?.to ?? null;

  // The first-year gate is judged at the EARLIER of `asOf` and the exit date.
  // Somebody who left after eleven months never completed a year, and must not
  // flip to 30 days on the leavers view the day the calendar passes an
  // anniversary they never reached (review H2; owner ruling Aug 31 2026:
  // "zero, unless first year is completed", leaver or not).
  const gateDate =
    employee.exitDate && employee.exitDate < asOf ? employee.exitDate : asOf;
  const completedFirstYear = hasCompletedFirstYear(employee.joiningDate, gateDate);
  const overridden =
    employedInYear &&
    employee.annualEntitlementDays !== undefined &&
    employee.annualEntitlementDays !== null;
  // An agreement is about a year the person worked in. It outranks the
  // first-year gate, not the employment window: it cannot make a year they
  // were never employed in worth anything.
  const entitlement = yearEntitlement(
    employedInYear,
    overridden,
    employee.annualEntitlementDays,
    completedFirstYear,
  );
  // The go-live seeds belong to ONE year. A grant written by the year-end roll
  // always wins; otherwise the seed counts only in its own year, and any other
  // year carries nothing in (review H6: before this, 1 January re-applied the
  // seeds to everyone and every prior year's overdraft or surplus vanished).
  const seedsApply =
    employee.seedLeaveYear === undefined ||
    employee.seedLeaveYear === null ||
    employee.seedLeaveYear === leaveYear;
  const carriedInRaw =
    input.carriedInDays ?? (seedsApply ? employee.carryoverDays : 0);
  const carriedIn = employedInYear ? capCarryover(carriedInRaw) : 0;
  const annualTaken = sumWeights(yearEntries, "ANNUAL", from, to);

  // NEVER clamped. A negative balance is leave taken in advance, which is legal
  // by agreement and present in the live data (four employees). A Math.max(0)
  // anywhere in this module is a bug.
  const annualBalance = roundDays(entitlement + carriedIn - annualTaken);

  const sickFullUsed =
    sumWeights(yearEntries, "SICK_FULL", from, to) +
    (employedInYear && seedsApply ? employee.openingSickUsed : 0);
  const sickHalfUsed = sumWeights(yearEntries, "SICK_HALF", from, to);
  const sickUnpaidUsed = sumWeights(yearEntries, "SICK_UNPAID", from, to);

  // Comp-off is a RUNNING balance, not an annual one: the workbook sums it with
  // no year bound and carries an opening figure. So it is bounded only by the
  // employment window: never by the leave year, and not by `asOf` either. A
  // comp-off approved for next Monday is a decision already made, exactly as
  // annual leave booked ahead has always counted; bounding this one by the
  // clock read "balance 1" for somebody who had already spent it (review M11).
  const compFrom = employee.joiningDate;
  const compTo = employee.exitDate ?? null;
  const onDutyDates = entries
    .filter((e) => e.category === "ON_DUTY" && isWithin(e.date, compFrom, compTo))
    .map((e) => e.date);
  const earnings = compOffEarnings({ onDutyDates, weekendDays: input.weekendDays });
  const compEarned = roundDays(earnings.length + employee.openingCompOff);
  const compTaken = sumWeights(entries, "COMP_OFF", compFrom, compTo);

  // The current spell is read from every employed day, not the year's entries:
  // a spell that began in December is still the one being taken in January.
  // Its end is only as far as the caller's entries reach (the services stop at
  // the leave year's end), so a spell running into next year ends 31 December.
  const employedEntries = entries.filter((e) => isWithin(e.date, compFrom, compTo));
  const maternityNow =
    leaveSpells(employedEntries, "MATERNITY", input).find((s) => s.from <= asOf && asOf <= s.to) ??
    null;

  return {
    leaveYear,
    asOf,
    employedInYear,
    hasCompletedFirstYear: completedFirstYear,
    nextAnniversary: nextAnniversary(employee.joiningDate, asOf),
    annual: {
      entitlement,
      entitlementOverridden: overridden,
      carriedIn,
      carriedInStored: roundDays(carriedInRaw),
      taken: annualTaken,
      balance: annualBalance,
    },
    sick: {
      full: tier(sickFullUsed, HR_SICK_TIER_DAYS.full),
      half: tier(sickHalfUsed, HR_SICK_TIER_DAYS.half),
      unpaid: tier(sickUnpaidUsed, HR_SICK_TIER_DAYS.unpaid),
    },
    compOff: {
      onDutyDays: sumWeights(entries, "ON_DUTY", compFrom, compTo),
      opening: roundDays(employee.openingCompOff),
      earned: compEarned,
      taken: compTaken,
      balance: roundDays(compEarned - compTaken),
      earnings,
    },
    maternity: {
      taken: sumWeights(yearEntries, "MATERNITY", from, to),
      current: maternityNow,
    },
    parental: {
      taken: sumWeights(yearEntries, "PARENTAL", from, to),
    },
  };
}

/**
 * What the year-end roll should write, decided purely so it can be tested
 * without a clock or a database.
 *
 * The closing annual balance becomes next year's carried-in figure, capped in
 * one direction. This is the piece the workbook has no equivalent for, because
 * it only ever holds a single year and the previous one arrives as a number
 * somebody typed.
 */
export function planYearRoll(closing: LeaveBalance): {
  fromYear: number;
  toYear: number;
  carryForwardDays: number;
  capped: boolean;
} {
  const raw = closing.annual.balance;
  const carried = capCarryover(raw);
  return {
    fromYear: closing.leaveYear,
    toYear: closing.leaveYear + 1,
    carryForwardDays: carried,
    capped: carried !== roundDays(raw),
  };
}
