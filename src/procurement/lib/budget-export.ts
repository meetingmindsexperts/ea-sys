/**
 * A budget version as a CSV that opens straight in Excel: a short header
 * block (event, version, status, currency, contingency), one row per line,
 * then a totals block. Every money cell is the stored ex-VAT figure rounded
 * to two decimals at the edge with the tax beside it, never a gross (spec
 * §7). Pure so the file's shape is pinned by a test and the route only
 * streams it; the numbers come from the same view the page renders, so the
 * export cannot disagree with the screen.
 *
 * Revenue and margin (17 September 2026) follow the expense blocks for a
 * caller with finance sight, from the same revenue view the budget page's
 * Revenue and margin section reads. For anyone else the file says in one row
 * that revenue was left out, rather than going quiet about it.
 */
import { toCsv } from "@/lib/csv-escape";
import { toDisplay } from "./money";

export interface ExportLine {
  lineKey: string;
  category: { code: string; name: string };
  product: { sku: string; name: string } | null;
  description: string;
  qty: string;
  unitCost: string;
  transactionCurrency: string;
  fxRateToReporting: string;
  planned: string;
  taxRatePercent: string | null;
  taxAmountPlanned: string;
  approvedPlanned: string | null;
  committedOpen: string;
  committedTotal: string;
  actual: string;
  paid: string;
  remaining: string;
  forecast: string;
  forecastReason: string | null;
  varianceNote: string | null;
  notes: string | null;
  isContingency: boolean;
  sortOrder: number;
}

export interface ExportBudget {
  eventCode: string;
  versionNo: number;
  status: string;
  reportingCurrency: string;
  contingencyPercent: string;
  contingencyAmount: string;
  plannedExpenseTotal: string;
  taxTotalPlanned: string;
  forecastTotal: string;
  expectedAttendance: number | null;
  recordedAttendance: number | null;
  atRisk: boolean;
  naCategoryCodes: string[];
  event: { name: string } | null;
  lines?: ExportLine[];
}

/**
 * The revenue side as the budget page receives it (budget-revenue-service's
 * BudgetRevenueView), declared structurally so this file stays pure and never
 * imports a service.
 */
export interface ExportRevenue {
  lines: {
    lineKey: string;
    category: { code: string; name: string };
    description: string;
    qty: string;
    unitAmount: string;
    transactionCurrency: string;
    fxRateToReporting: string;
    planned: string;
    notes: string | null;
    sortOrder: number;
  }[];
  accounts: { code: string; name: string; planned: string; actual: string }[];
  actuals: {
    notItemised: string;
    noAccount: { amount: string; products: { productName: string }[] };
    notConverted: { from: string; currency: string; amount: string }[];
    total: string;
    paidRegistrations: number;
    wonDeals: number;
  };
  margin: {
    plannedRevenue: string;
    plannedCost: string;
    plannedMargin: string;
    plannedMarginPercent: string | null;
    forecastRevenue: string;
    forecastCost: string;
    forecastMargin: string;
    forecastMarginPercent: string | null;
    belowTarget: boolean;
  };
  targetMarginPercent: string | null;
}

/** "hidden": the caller has no finance sight, so the file says revenue was left out. */
export type ExportRevenueOption = ExportRevenue | "hidden";

/** Two decimals, banker's rounding at the edge; an absent figure is an empty cell, never "0.00". */
function fmt(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  return toDisplay(v).toFixed(2);
}

export function budgetExportFilename(b: Pick<ExportBudget, "eventCode" | "versionNo">): string {
  const code = b.eventCode.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `budget-${code}-v${b.versionNo}.csv`;
}

export function budgetCsvColumns(reportingCurrency: string): string[] {
  const cur = reportingCurrency;
  return [
    "Category",
    "Category name",
    "SKU",
    "Description",
    "Qty",
    "Unit cost",
    "Currency",
    `Rate to ${cur}`,
    `Planned (${cur}, ex-VAT)`,
    "Tax %",
    `Tax (${cur})`,
    `Approved planned (${cur})`,
    `Committed open (${cur})`,
    `Committed total (${cur})`,
    `Actual (${cur})`,
    `Paid (${cur})`,
    `Remaining (${cur})`,
    `Forecast (${cur})`,
    "Forecast reason",
    "Variance note",
    "Notes",
    "Contingency line",
  ];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function revenueRows(r: ExportRevenue, cur: string): unknown[][] {
  const lines = [...r.lines].sort((x, y) => x.sortOrder - y.sortOrder || x.lineKey.localeCompare(y.lineKey));
  const target = r.targetMarginPercent;
  const unmapped = r.actuals.noAccount.products.map((p) => p.productName);
  return [
    [],
    ["Revenue"],
    ["Income account", "Account name", `Planned (${cur}, ex-VAT)`, `Actual (${cur}, ex-VAT)`, `Actual less planned (${cur})`],
    ...r.accounts.map((a) => [a.code, a.name, fmt(a.planned), fmt(a.actual), toDisplay(a.actual).minus(toDisplay(a.planned)).toFixed(2)]),
    ["", "Not itemised on won deals", "", fmt(r.actuals.notItemised), ""],
    ["", "Products with no income account", "", fmt(r.actuals.noAccount.amount), unmapped.join("; ")],
    ["", "Total", fmt(r.margin.plannedRevenue), fmt(r.actuals.total), ""],
    ["Counted from", `${plural(r.actuals.paidRegistrations, "paid registration")}, ${plural(r.actuals.wonDeals, "won deal")}`],
    ...r.actuals.notConverted.map((n) => [`Not counted, no fixed rate to ${cur}`, n.from, `${n.currency} ${fmt(n.amount)}`]),
    [],
    ["Planned revenue lines"],
    ["Income account", "Account name", "Description", "Qty", "Unit amount", "Currency", `Rate to ${cur}`, `Planned (${cur}, ex-VAT)`, "Notes"],
    ...lines.map((l) => [l.category.code, l.category.name, l.description, fmt(l.qty), fmt(l.unitAmount), l.transactionCurrency, l.fxRateToReporting, fmt(l.planned), l.notes ?? ""]),
    [],
    ["Margin", "Planned", "Forecast"],
    [`Revenue (${cur}, ex-VAT)`, fmt(r.margin.plannedRevenue), fmt(r.margin.forecastRevenue)],
    [`Cost (${cur}, ex-VAT, with contingency)`, fmt(r.margin.plannedCost), fmt(r.margin.forecastCost)],
    [`Margin (${cur})`, fmt(r.margin.plannedMargin), fmt(r.margin.forecastMargin)],
    ["Margin %", r.margin.plannedMarginPercent ?? "", r.margin.forecastMarginPercent ?? ""],
    ["Target margin %", target ?? ""],
    ["Forecast below target", target === null ? "" : r.margin.belowTarget ? "yes" : "no"],
  ];
}

export function buildBudgetCsv(b: ExportBudget, exportedAt: Date, opts: { revenue?: ExportRevenueOption } = {}): string {
  const cur = b.reportingCurrency;
  const lines = [...(b.lines ?? [])].sort((x, y) => x.sortOrder - y.sortOrder || x.lineKey.localeCompare(y.lineKey));
  const contingencyPct = Number(b.contingencyPercent);
  const plannedPlusContingency = toDisplay(b.plannedExpenseTotal).plus(toDisplay(b.contingencyAmount)).toFixed(2);

  const header: unknown[][] = [
    ["Budget export"],
    ["Event", b.eventCode],
    ["Event name", b.event?.name ?? ""],
    ["Version", b.versionNo],
    ["Status", b.status],
    ["Reporting currency", cur],
    ["Contingency %", Number.isFinite(contingencyPct) ? contingencyPct : b.contingencyPercent],
    ["Expected attendance", b.expectedAttendance ?? ""],
    ["Recorded attendance", b.recordedAttendance ?? ""],
    ["Not applicable", b.naCategoryCodes.join("; ")],
    ["Exported at", exportedAt.toISOString()],
    [],
  ];

  const table: unknown[][] = [
    budgetCsvColumns(cur),
    ...lines.map((l) => [
      l.category.code,
      l.category.name,
      l.product?.sku ?? "",
      l.description,
      fmt(l.qty),
      fmt(l.unitCost),
      l.transactionCurrency,
      l.fxRateToReporting,
      fmt(l.planned),
      l.taxRatePercent ?? "",
      fmt(l.taxAmountPlanned),
      fmt(l.approvedPlanned),
      fmt(l.committedOpen),
      fmt(l.committedTotal),
      fmt(l.actual),
      fmt(l.paid),
      fmt(l.remaining),
      fmt(l.forecast),
      l.forecastReason ?? "",
      l.varianceNote ?? "",
      l.notes ?? "",
      l.isContingency ? "yes" : "",
    ]),
  ];

  const totals: unknown[][] = [
    [],
    ["Totals"],
    [`Planned (${cur}, ex-VAT)`, fmt(b.plannedExpenseTotal)],
    [`Tax (${cur})`, fmt(b.taxTotalPlanned)],
    [`Contingency (${Number.isFinite(contingencyPct) ? contingencyPct : b.contingencyPercent}%)`, fmt(b.contingencyAmount)],
    [`Planned plus contingency (${cur})`, plannedPlusContingency],
    [`Forecast (${cur})`, fmt(b.forecastTotal)],
    ["At risk", b.atRisk ? "yes" : "no"],
    ["Lines", lines.length],
  ];

  const revenue: unknown[][] =
    opts.revenue === undefined ? [] : opts.revenue === "hidden" ? [[], ["Revenue", "Not included: revenue and margin need finance access"]] : revenueRows(opts.revenue, cur);

  return toCsv([...header, ...table, ...totals, ...revenue]);
}
