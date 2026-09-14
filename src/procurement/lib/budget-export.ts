/**
 * A budget version as a CSV that opens straight in Excel: a short header
 * block (event, version, status, currency, contingency), one row per line,
 * then a totals block. Every money cell is the stored ex-VAT figure rounded
 * to two decimals at the edge with the tax beside it, never a gross (spec
 * §7). Pure so the file's shape is pinned by a test and the route only
 * streams it; the numbers come from the same view the page renders, so the
 * export cannot disagree with the screen.
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

export function buildBudgetCsv(b: ExportBudget, exportedAt: Date): string {
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

  return toCsv([...header, ...table, ...totals]);
}
