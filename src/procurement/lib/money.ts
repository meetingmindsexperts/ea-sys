/**
 * Money rules for the Budget & Procurement module (spec §7, §6a).
 *
 * Decimal only, never float: a budget is a set of sums finance signs off.
 * Values are STORED to 4 decimals and DISPLAYED to 2; the sum-vs-display
 * drift (at most 0.02 on a total) is resolved at the total with banker's
 * rounding, never by adjusting a line. Every planned / committed / actual /
 * paid figure is ex-VAT in the budget's reporting currency, with the tax
 * beside it. Client-safe: pure functions over decimal.js.
 */
import DecimalBase from "decimal.js";

/**
 * A private constructor: `Decimal.set` would mutate the library's shared
 * singleton for every other importer in the process (review L1), so this
 * module works on its own clone with the precision and rounding spec §7 asks
 * for. The clone is exported for callers that need to construct values.
 */
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_EVEN });
export type Decimal = InstanceType<typeof Decimal>;

/**
 * Anything with a decimal string form: our Decimal, a Prisma Decimal (the
 * same library bundled inside @prisma/client, so `instanceof` is FALSE for a
 * row value, review H1), a string or a number.
 */
export type MoneyInput = Decimal | DecimalBase | { toString(): string } | string | number;

export const STORE_DP = 4;
export const DISPLAY_DP = 2;
/** Spec §6a: the event owner may move up to 10% of a line's approved planned amount per version. */
export const REALLOCATION_CAP_RATIO = new Decimal("0.10");
/** Spec §14 Q8: contingency defaults to 10% of plannedExpenseTotal (which excludes it). */
export const DEFAULT_CONTINGENCY_PERCENT = new Decimal(10);
/** Spec §14 Q13: a variance note is required past 10% or AED 5,000, whichever is larger. */
export const VARIANCE_NOTE_RATIO = new Decimal("0.10");
export const VARIANCE_NOTE_FLOOR_AED = new Decimal(5000);

export function money(v: MoneyInput | null | undefined): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  if (v instanceof Decimal) return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("money(): not a finite number");
    return new Decimal(v);
  }
  // A Prisma Decimal, a decimal.js value from the library's own singleton,
  // or a string: all go through the string form, which is exact.
  const text = typeof v === "string" ? v.trim() : String(v);
  let d: Decimal;
  try {
    d = new Decimal(text);
  } catch {
    throw new Error(`money(): not a decimal amount: ${JSON.stringify(text)}`);
  }
  if (!d.isFinite()) throw new Error("money(): not a finite amount");
  return d;
}

/** The stored shape: 4 dp, banker's rounding. */
export function toStored(v: MoneyInput): Decimal {
  return money(v).toDecimalPlaces(STORE_DP, Decimal.ROUND_HALF_EVEN);
}

/** The displayed shape: 2 dp, banker's rounding, applied at a TOTAL, never to lines. */
export function toDisplay(v: MoneyInput): Decimal {
  return money(v).toDecimalPlaces(DISPLAY_DP, Decimal.ROUND_HALF_EVEN);
}

/** A stored string for a Decimal column. */
export function storedString(v: MoneyInput): string {
  return toStored(v).toFixed(STORE_DP);
}

export function assertRate(rate: MoneyInput): Decimal {
  const r = money(rate);
  if (!r.gt(0)) throw new RangeError("An FX rate must be greater than zero (spec §7.3).");
  return r;
}

export function assertNonNegative(v: MoneyInput, what = "amount"): Decimal {
  const d = money(v);
  if (d.lt(0)) throw new RangeError(`A planned ${what} cannot be negative (spec §7.6).`);
  return d;
}

export interface LineInput {
  qty: MoneyInput;
  unitCost: MoneyInput;
  /** transaction currency → reporting currency; 1 when they are the same. */
  fxRateToReporting: MoneyInput;
  /** Percent, e.g. 5 for UAE VAT; null or 0 for out of scope / reverse charge. */
  taxRatePercent?: MoneyInput | null;
}

export interface LineTotals {
  /** qty × unitCost in the transaction currency, ex-VAT. */
  plannedTransaction: Decimal;
  /** The same in the reporting currency at the snapshot rate, ex-VAT (stored as `planned`). */
  planned: Decimal;
  /** VAT on `planned`, in the reporting currency (stored as `taxAmountPlanned`). */
  taxAmountPlanned: Decimal;
}

/** Planned figures for one line, all to 4 dp. */
export function lineTotals(input: LineInput): LineTotals {
  const qty = assertNonNegative(input.qty, "quantity");
  const unitCost = assertNonNegative(input.unitCost, "unit cost");
  const rate = assertRate(input.fxRateToReporting);
  const plannedTransaction = toStored(qty.mul(unitCost));
  const planned = toStored(plannedTransaction.mul(rate));
  const taxPct = money(input.taxRatePercent ?? 0);
  if (taxPct.lt(0)) throw new RangeError("A tax rate cannot be negative.");
  const taxAmountPlanned = toStored(planned.mul(taxPct).div(100));
  return { plannedTransaction, planned, taxAmountPlanned };
}

/** remaining = planned − committedOpen − actual (spec §7.7). May be negative: an approved exception leaves it so, shown as such. */
export function remaining(line: { planned: MoneyInput; committedOpen: MoneyInput; actual: MoneyInput }): Decimal {
  return toStored(money(line.planned).minus(money(line.committedOpen)).minus(money(line.actual)));
}

/** forecastFinalAmount defaults to max(planned, committedOpen + actual) (spec §7.7). */
export function forecastDefault(line: { planned: MoneyInput; committedOpen: MoneyInput; actual: MoneyInput }): Decimal {
  const planned = money(line.planned);
  const known = money(line.committedOpen).plus(money(line.actual));
  return toStored(Decimal.max(planned, known));
}

/** The line's forecast: the owner's override when set, else the default. */
export function forecastFor(line: {
  planned: MoneyInput;
  committedOpen: MoneyInput;
  actual: MoneyInput;
  forecastFinalAmount?: MoneyInput | null;
}): Decimal {
  if (line.forecastFinalAmount !== null && line.forecastFinalAmount !== undefined && line.forecastFinalAmount !== "") {
    return toStored(line.forecastFinalAmount);
  }
  return forecastDefault(line);
}

/** Contingency is a percent of plannedExpenseTotal, which EXCLUDES the contingency line (spec §6a). */
export function contingencyAmount(plannedExpenseTotal: MoneyInput, contingencyPercent: MoneyInput): Decimal {
  const pct = money(contingencyPercent);
  if (pct.lt(0)) throw new RangeError("Contingency percent cannot be negative.");
  return toStored(money(plannedExpenseTotal).mul(pct).div(100));
}

export interface BudgetLineForTotals {
  planned: MoneyInput;
  taxAmountPlanned: MoneyInput;
  committedOpen: MoneyInput;
  actual: MoneyInput;
  forecastFinalAmount?: MoneyInput | null;
  isContingency: boolean;
  deletedAt?: Date | string | null;
}

export interface BudgetTotals {
  plannedExpenseTotal: Decimal;
  taxTotalPlanned: Decimal;
  contingencyAmount: Decimal;
  /** Sum of every live line's forecast, contingency line included. */
  forecastTotal: Decimal;
  /** Spec §6a: at risk when forecast exceeds plannedExpenseTotal + contingency. */
  atRisk: boolean;
}

/**
 * Roll the lines up. Deleted lines count for nothing; the contingency line is
 * excluded from plannedExpenseTotal (the approval ceiling reads it) and the
 * contingency AMOUNT is recomputed from the percent, so the two cannot drift.
 */
export function budgetTotals(lines: readonly BudgetLineForTotals[], contingencyPercent: MoneyInput): BudgetTotals {
  let planned = new Decimal(0);
  let tax = new Decimal(0);
  let forecast = new Decimal(0);
  for (const l of lines) {
    if (l.deletedAt) continue;
    if (!l.isContingency) {
      planned = planned.plus(money(l.planned));
      tax = tax.plus(money(l.taxAmountPlanned));
    }
    forecast = forecast.plus(forecastFor(l));
  }
  const plannedExpenseTotal = toStored(planned);
  const contingency = contingencyAmount(plannedExpenseTotal, contingencyPercent);
  const forecastTotal = toStored(forecast);
  return {
    plannedExpenseTotal,
    taxTotalPlanned: toStored(tax),
    contingencyAmount: contingency,
    forecastTotal,
    atRisk: isAtRisk(forecastTotal, plannedExpenseTotal, contingency),
  };
}

export function isAtRisk(forecastTotal: MoneyInput, plannedExpenseTotal: MoneyInput, contingency: MoneyInput): boolean {
  return money(forecastTotal).gt(money(plannedExpenseTotal).plus(money(contingency)));
}

/** The most an owner may move OUT of a line per version without approval: 10% of its approved planned amount. */
export function reallocationCap(approvedPlanned: MoneyInput): Decimal {
  return toStored(assertNonNegative(approvedPlanned, "amount").mul(REALLOCATION_CAP_RATIO));
}

/**
 * Does moving `amount` more, on top of `movedSoFarThisVersion`, exceed the
 * owner's 10% authority on this line? Inclusive: exactly 10% is allowed.
 */
export function reallocationExceedsCap(input: {
  approvedPlanned: MoneyInput;
  movedSoFarThisVersion: MoneyInput;
  amount: MoneyInput;
}): boolean {
  const amount = money(input.amount);
  if (amount.lte(0)) throw new RangeError("A reallocation moves a positive amount.");
  return money(input.movedSoFarThisVersion).plus(amount).gt(reallocationCap(input.approvedPlanned));
}

/**
 * Close-out (spec §14 Q13): a line whose actual differs from planned by more
 * than 10% or the AED-5,000 floor (given in the reporting currency), whichever
 * is larger, needs a written variance note.
 */
export function varianceRequiresNote(input: { planned: MoneyInput; actual: MoneyInput; floorInReporting: MoneyInput }): boolean {
  const planned = money(input.planned);
  const diff = money(input.actual).minus(planned).abs();
  const threshold = Decimal.max(planned.abs().mul(VARIANCE_NOTE_RATIO), money(input.floorInReporting));
  return diff.gt(threshold);
}

/** Convert a reporting-currency amount to AED for the approval ceiling (spec §4, §7.9). */
export function toAed(amountReporting: MoneyInput, reportingToAedRate: MoneyInput): Decimal {
  return toStored(money(amountReporting).mul(assertRate(reportingToAedRate)));
}

/**
 * Reporting currency to AED until the FX provider lands (spec §7.3, Phase 3).
 * The pegs are facts and are never taken from the caller. A floating
 * currency's rate is the caller's, but it must sit inside a wide plausibility
 * band: the requester must not be able to pick the rate that decides who
 * approves (a rate of 0.0001 would route a two-million budget to the lowest
 * tier) or that sets the variance-note floor. The band is a rail, not a price:
 * EUR and GBP have traded between 3.6 and 6.2 AED this century.
 */
export const AED_PEG_RATES: Readonly<Record<string, string>> = { AED: "1", USD: "3.6725", SAR: "0.97933" };
export const FLOATING_TO_AED_BAND = { min: "2.5", max: "8" } as const;
export type RateResolution =
  | { ok: true; rate: Decimal; source: "peg" | "caller" }
  | { ok: false; reason: "missing" | "out-of-band" };
export function resolveReportingToAedRate(reportingCurrency: string, given: MoneyInput | null | undefined): RateResolution {
  const peg = AED_PEG_RATES[reportingCurrency];
  if (peg !== undefined) return { ok: true, rate: money(peg), source: "peg" };
  if (given === null || given === undefined || given === "") return { ok: false, reason: "missing" };
  const rate = money(given);
  if (rate.lt(FLOATING_TO_AED_BAND.min) || rate.gt(FLOATING_TO_AED_BAND.max)) return { ok: false, reason: "out-of-band" };
  return { ok: true, rate, source: "caller" };
}

/** Sum stored (4 dp) figures and present the 2 dp total: the one place display rounding happens. */
export function displayTotal(values: readonly MoneyInput[]): Decimal {
  return toDisplay(values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0)));
}
