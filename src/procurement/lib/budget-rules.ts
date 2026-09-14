/**
 * The budget lifecycle's pure decisions (spec §6a), kept out of the service
 * so each is a table of cases in tests: what makes a draft complete enough to
 * submit, how a line clones into a new version, and when a reallocation is
 * within the owner's own authority. Client-safe.
 */
import { money, reallocationExceedsCap, storedString, type MoneyInput } from "./money";

export interface CompletenessBudget {
  reportingCurrency: string | null;
  expectedAttendance: number | null;
  contingencyPercent: MoneyInput | null;
  naCategoryCodes: readonly string[];
}
export interface CompletenessLine {
  categoryId: string;
  isContingency: boolean;
  deletedAt: Date | string | null;
  transactionCurrency: string;
  fxRateToReporting: MoneyInput;
}
export interface CompletenessCategory {
  id: string;
  code: string;
  depth: number;
  isActive: boolean;
}

/**
 * Spec §6a: every category either has lines or is explicitly marked not
 * applicable, contingency set, reporting currency set, expectedAttendance set.
 * Returns the human list of what is missing; empty means submittable.
 */
export function missingForSubmission(
  budget: CompletenessBudget,
  lines: readonly CompletenessLine[],
  categories: readonly CompletenessCategory[],
  contingencyCode: string,
): string[] {
  const missing: string[] = [];
  if (!budget.reportingCurrency) missing.push("Reporting currency is not set.");
  if (budget.contingencyPercent === null || budget.contingencyPercent === undefined) missing.push("Contingency percent is not set.");
  if (!budget.expectedAttendance || budget.expectedAttendance <= 0) missing.push("Expected attendance is required at submission.");
  const live = lines.filter((l) => !l.deletedAt);
  if (live.filter((l) => !l.isContingency).length === 0) missing.push("The budget has no lines.");
  const covered = new Set(live.map((l) => l.categoryId));
  const na = new Set(budget.naCategoryCodes);
  for (const c of categories) {
    if (!c.isActive || c.depth !== 0 || c.code === contingencyCode) continue;
    if (!covered.has(c.id) && !na.has(c.code)) missing.push(`Category ${c.code} has no lines and is not marked not applicable.`);
  }
  for (const l of live) {
    if (budget.reportingCurrency && l.transactionCurrency !== budget.reportingCurrency && money(l.fxRateToReporting).lte(0)) {
      missing.push(`A ${l.transactionCurrency} line has no exchange rate.`);
    }
  }
  return missing;
}

export interface LineForClone {
  lineKey: string;
  templateLineId: string | null;
  categoryId: string;
  description: string;
  qty: MoneyInput;
  unitCost: MoneyInput;
  transactionCurrency: string;
  fxRateToReporting: MoneyInput;
  fxRateSource: string;
  fxRateAsOf: Date | null;
  planned: MoneyInput;
  committedOpen: MoneyInput;
  committedTotal: MoneyInput;
  actual: MoneyInput;
  paid: MoneyInput;
  taxCode: string | null;
  taxRatePercent: MoneyInput | null;
  taxAmountPlanned: MoneyInput;
  forecastFinalAmount: MoneyInput | null;
  forecastReason: string | null;
  serviceStart: Date | null;
  serviceEnd: Date | null;
  notes: string | null;
  isContingency: boolean;
  sortOrder: number;
}

/**
 * A new version keeps the lineKey (commitments and actuals follow the line,
 * not the version, spec §6a) and every figure; the approval base and the
 * owner's moved-so-far reset, because they belong to the version.
 */
export function cloneLineForNewVersion(line: LineForClone) {
  return {
    lineKey: line.lineKey,
    templateLineId: line.templateLineId,
    categoryId: line.categoryId,
    description: line.description,
    qty: storedString(line.qty),
    unitCost: storedString(line.unitCost),
    transactionCurrency: line.transactionCurrency,
    fxRateToReporting: money(line.fxRateToReporting).toString(),
    fxRateSource: line.fxRateSource,
    fxRateAsOf: line.fxRateAsOf,
    planned: storedString(line.planned),
    committedOpen: storedString(line.committedOpen),
    committedTotal: storedString(line.committedTotal),
    actual: storedString(line.actual),
    paid: storedString(line.paid),
    taxCode: line.taxCode,
    taxRatePercent: line.taxRatePercent === null ? null : money(line.taxRatePercent).toString(),
    taxAmountPlanned: storedString(line.taxAmountPlanned),
    forecastFinalAmount: line.forecastFinalAmount === null ? null : storedString(line.forecastFinalAmount),
    forecastReason: line.forecastReason,
    serviceStart: line.serviceStart,
    serviceEnd: line.serviceEnd,
    notes: line.notes,
    isContingency: line.isContingency,
    sortOrder: line.sortOrder,
    approvedPlanned: null as string | null,
    reallocatedOut: "0.0000",
  };
}

export type ReallocationAuthority = "OWNER" | "APPROVAL_REQUIRED";

/**
 * Spec §6a / §14 Q2: the owner moves up to 10% of a line's APPROVED planned
 * amount per version on their own authority; anything beyond is an approval
 * request on the AED matrix. Judged on the FROM line, cumulatively.
 */
export function reallocationAuthority(from: {
  approvedPlanned: MoneyInput | null;
  planned: MoneyInput;
  reallocatedOut: MoneyInput;
}, amount: MoneyInput): ReallocationAuthority {
  const base = from.approvedPlanned === null || from.approvedPlanned === undefined ? from.planned : from.approvedPlanned;
  return reallocationExceedsCap({ approvedPlanned: base, movedSoFarThisVersion: from.reallocatedOut, amount })
    ? "APPROVAL_REQUIRED"
    : "OWNER";
}
