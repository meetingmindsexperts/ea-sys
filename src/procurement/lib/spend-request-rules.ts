/**
 * The pure rules of a spend request (spec §6, §7, §8): which budgets take
 * one, how its amount reaches the budget's reporting currency, what the
 * budget check says, and what an amount change after approval means. No
 * database: the service executes these, the form's side panel shows them,
 * and the tests pin them.
 */
import { AED_PEG_RATES, Decimal, FLOATING_TO_AED_BAND, money, remaining, toStored, type MoneyInput } from "./money";

/** Only an active budget accepts a request; a frozen one still does, on the normal matrix within a line's remaining (spec §6a, §8.5). */
export const REQUESTABLE_BUDGET_STATUSES = ["ACTIVE", "FROZEN"] as const;
export type RequestableBudgetStatus = (typeof REQUESTABLE_BUDGET_STATUSES)[number];
export function budgetAcceptsRequests(status: string): status is RequestableBudgetStatus {
  return (REQUESTABLE_BUDGET_STATUSES as readonly string[]).includes(status);
}

export type SpendRequestStatusValue = "DRAFT" | "SUBMITTED" | "BUDGET_CHECKED" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "CANCELLED" | "AWAITING_SUPPLIER" | "CONVERTED" | "CLOSED";
export const SPEND_REQUEST_STATUS_LABEL: Record<SpendRequestStatusValue, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  BUDGET_CHECKED: "Budget checked",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  AWAITING_SUPPLIER: "Awaiting supplier",
  /** The request became a purchase order: what the person sees is the order (owner, 15 Sep 2026: "approved requests are purchase orders"). */
  CONVERTED: "Ordered",
  CLOSED: "Closed",
};
/** The statuses that still sit on a line: they are shown beside the check as "already asked for" and are never counted in the stored figures. */
export const OPEN_REQUEST_STATUSES = ["PENDING_APPROVAL", "APPROVED", "AWAITING_SUPPLIER"] as const;
/** A request that is over and done with; nothing changes it any more. */
export const TERMINAL_REQUEST_STATUSES = ["REJECTED", "CANCELLED", "CONVERTED", "CLOSED"] as const;

export type BudgetCheckStatusValue = "NOT_CHECKED" | "WITHIN_BUDGET" | "OVER_BUDGET" | "FROZEN";
export const BUDGET_CHECK_LABEL: Record<BudgetCheckStatusValue, string> = {
  NOT_CHECKED: "Not checked",
  WITHIN_BUDGET: "Within budget",
  OVER_BUDGET: "Over budget",
  FROZEN: "Over budget on a frozen budget",
};

export type RequestRateResolution =
  | { ok: true; rate: Decimal; source: "same" | "peg" | "caller" }
  | { ok: false; reason: "missing" | "invalid" | "out-of-band" };

/** The two floating currencies against each other (EUR and GBP): a rail, not a price; they have traded between 0.6 and 1.5 this century. */
export const FLOATING_PAIR_BAND = { min: "0.5", max: "2" } as const;

/**
 * The request's currency to the budget's reporting currency. The same
 * currency is 1; two pegged currencies derive from the AED pegs (facts, never
 * the caller's); a pair with a floating side takes the caller's rate, but the
 * rate it implies for the floating currency against AED must sit inside the
 * same plausibility band the budget's own rate must (spec §7.3): this rate
 * decides the figure the budget check reads and, through it, who approves,
 * so a requester must not be able to type 0.001 and route two million past
 * the lowest tier. The rate to AED for the ceiling is a separate question the
 * budget's `resolveReportingToAedRate` answers.
 */
export function resolveRequestToReportingRate(requestCurrency: string, reportingCurrency: string, given: MoneyInput | null | undefined): RequestRateResolution {
  const req = requestCurrency.toUpperCase();
  const rep = reportingCurrency.toUpperCase();
  if (req === rep) return { ok: true, rate: new Decimal(1), source: "same" };
  const reqPeg = AED_PEG_RATES[req];
  const repPeg = AED_PEG_RATES[rep];
  if (reqPeg !== undefined && repPeg !== undefined) return { ok: true, rate: money(reqPeg).div(money(repPeg)), source: "peg" };
  if (given === null || given === undefined || given === "") return { ok: false, reason: "missing" };
  const rate = money(given);
  if (!rate.isFinite() || rate.lte(0)) return { ok: false, reason: "invalid" };
  // The floating side's implied rate to AED: request floating means given x peg(reporting); reporting floating means peg(request) / given.
  const implied = repPeg !== undefined ? rate.mul(money(repPeg)) : reqPeg !== undefined ? money(reqPeg).div(rate) : null;
  const band = implied === null ? FLOATING_PAIR_BAND : FLOATING_TO_AED_BAND;
  const judged = implied ?? rate;
  if (judged.lt(band.min) || judged.gt(band.max)) return { ok: false, reason: "out-of-band" };
  return { ok: true, rate, source: "caller" };
}

/** An amount in the request's currency, ex-VAT, expressed in the reporting currency at 4 dp. */
export function toReporting(amount: MoneyInput, rate: MoneyInput): Decimal {
  return toStored(money(amount).mul(money(rate)));
}

export interface BudgetCheckInput {
  budgetStatus: string;
  line: { planned: MoneyInput; committedOpen: MoneyInput; actual: MoneyInput };
  /** The request ex-VAT in the reporting currency. */
  amountReporting: MoneyInput;
  /** What this request already holds on the line (a commitment already counted in committedOpen); zero before conversion. */
  alreadyCommitted?: MoneyInput;
}
export interface BudgetCheckOutcome {
  status: Exclude<BudgetCheckStatusValue, "NOT_CHECKED">;
  /** Routed to the final approver, never silently allowed (spec §6). */
  exception: boolean;
  /** A frozen budget's exception needs the requester's reason (spec §8.5). */
  reasonRequired: boolean;
  amountReporting: Decimal;
  /** The line's remaining before and after this request, reporting currency; after may be negative. */
  remainingBefore: Decimal;
  remainingAfter: Decimal;
}

/**
 * The budget check, per line against the STORED figures (spec §6): remaining
 * is planned minus committed-open minus actual; a request that leaves it
 * negative is over budget. On a frozen budget the over-budget case is the
 * FROZEN outcome, an exception with a reason; within remaining it runs on the
 * normal matrix like an active budget. A draw from the contingency line is a
 * request like any other.
 */
export function budgetCheck(input: BudgetCheckInput): BudgetCheckOutcome {
  const amountReporting = toStored(input.amountReporting);
  const effective = amountReporting.minus(money(input.alreadyCommitted ?? 0));
  const remainingBefore = remaining(input.line);
  const remainingAfter = toStored(remainingBefore.minus(effective));
  const over = remainingAfter.lt(0);
  if (over && input.budgetStatus === "FROZEN") return { status: "FROZEN", exception: true, reasonRequired: true, amountReporting, remainingBefore, remainingAfter };
  if (over) return { status: "OVER_BUDGET", exception: true, reasonRequired: false, amountReporting, remainingBefore, remainingAfter };
  return { status: "WITHIN_BUDGET", exception: false, reasonRequired: false, amountReporting, remainingBefore, remainingAfter };
}

/** What a request still lacks before it can be submitted; the page shows the list and the submit refuses on it (spec §6: quotes, a line, a vendor). */
export function missingForSubmission(r: { lineKey: string | null; supplierId: string | null; proposedVendorName: string | null; amount: MoneyInput; quotes: unknown[] }): string[] {
  const missing: string[] = [];
  if (!r.lineKey) missing.push("a budget line to request against");
  if (money(r.amount).lte(0)) missing.push("an amount greater than zero");
  if (!r.supplierId && !r.proposedVendorName) missing.push("a supplier, or the name of the vendor you propose");
  if (r.quotes.length === 0) missing.push("at least one quote");
  return missing;
}

export type AmendmentDirection = "INCREASE" | "DECREASE" | "SAME";
/**
 * An amount change after approval (spec §6 "changes after approval"): a
 * higher amount is re-approved for the difference by whoever the NEW TOTAL
 * requires, so a series of small rises cannot cross a ceiling in pieces; a
 * lower amount applies at once and is audited.
 */
export function amendmentEffect(previousReporting: MoneyInput, nextReporting: MoneyInput): { direction: AmendmentDirection; delta: Decimal } {
  const delta = toStored(money(nextReporting).minus(money(previousReporting)));
  if (delta.gt(0)) return { direction: "INCREASE", delta };
  if (delta.lt(0)) return { direction: "DECREASE", delta };
  return { direction: "SAME", delta };
}
