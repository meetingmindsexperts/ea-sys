/**
 * The budget sheet reader (docs/BUDGET_AI_PLAN.md stage 1, "finance's Excel
 * budget sheets"; first real sheet: 2nd OGSC 2026, Oct 28 2026). Two pure
 * halves, no database, so every rule is testable from a string (the
 * px-import pattern):
 *
 *   parseBudgetSheet   reads the costing sheet finance keeps per event: a
 *                      SUBJECT / TYPE / ACT COST / ITEMS / DAYS / TOTAL block
 *                      for what the event costs, a PER UNIT / ITEMS / DAYS /
 *                      TOTAL block for what the client is billed, then MARGIN,
 *                      VENDOR, QUOTATION, COMMENTS. Section rows ("01 - ..."),
 *                      repeated header rows, group labels and "Total" rows are
 *                      recognised and never read as lines.
 *   planBudgetSheet    turns the lines into what a budget needs: a catalogue
 *                      product per cost line, an income account per billed
 *                      line, quantities and unit amounts, and every warning a
 *                      person must see before the draft is created.
 *
 * The sheet's own subtotals are NEVER used as figures. Every total is
 * recomputed from the lines, and a sheet subtotal that disagrees is a warning
 * naming the row it left out when one row explains the gap (the OGSC sheet's
 * Onsite total skipped Poster Panels). Amounts are ex-VAT: finance enters them
 * that way (owner, Oct 28 2026); the VAT rate is chosen per line on the
 * preview.
 *
 * Client-safe: no Node imports.
 */
import { accountGroupCode, CONTINGENCY_CATEGORY_CODE } from "./budget-categories-seed";

export const SHEET_MAX_ROWS = 2_000;

export type SheetLineType = "INTERNAL" | "EXTERNAL" | null;

export interface SheetAmounts {
  /** The unit as the sheet shows it (often rounded for display). */
  unit: number | null;
  items: number;
  days: number;
  /** The TOTAL cell; null when the sheet left it blank. */
  total: number | null;
}

export interface SheetLine {
  rowNum: number;
  /** "1.1", or "" when the sheet gave the row no number. */
  ref: string;
  section: string;
  group: string | null;
  description: string;
  type: SheetLineType;
  cost: SheetAmounts;
  /** Null when the billed block is blank: the line is billed to nobody. */
  billed: SheetAmounts | null;
  sheetMargin: number | null;
  vendor: string;
  quotation: string;
  comments: string;
  /** "Contingency (3%)" carries its percent; every other line is null. */
  contingencyPercent: number | null;
}

export interface SheetTotalRow {
  rowNum: number;
  label: string;
  /** True for SUBTOTAL / TOTAL EXPENSES, which sum the sheet's own section totals. */
  cumulative: boolean;
  cost: number | null;
  billed: number | null;
  margin: number | null;
  /** The lines this total covers (non-cumulative rows only). */
  lineRows: number[];
}

export interface SheetFooterFigure {
  rowNum: number;
  label: string;
  value: number;
}

export interface ParsedSheet {
  title: string;
  lines: SheetLine[];
  totals: SheetTotalRow[];
  footer: SheetFooterFigure[];
  errors: { rowNum: number; message: string }[];
}

// ── tokenising ──────────────────────────────────────────────────────────────

/** Semicolon when the first lines carry more semicolons than commas (Excel in a comma-decimal locale). */
export function detectDelimiter(text: string): ";" | "," {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  const semi = (head.match(/;/g) ?? []).length;
  const comma = (head.match(/,/g) ?? []).length;
  return semi >= comma ? ";" : ",";
}

/** RFC 4180 rows with the given delimiter; quoted cells may span lines (the OGSC comments do). */
export function tokenise(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * A money or count cell: "AED 1,234", "-AED 15,426", "AED637,345.20", "(500)",
 * "150", "". Null for a blank cell; NaN for text that is not a number, so the
 * caller can name the row.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/^[A-Za-z]{3}\s*/, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/,/g, "").replace(/\s+/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return Number.NaN;
  const n = Number(s);
  return negative ? -n : n;
}

// ── parsing ─────────────────────────────────────────────────────────────────

interface Columns {
  ref: number;
  description: number;
  type: number;
  costUnit: number;
  billedUnit: number;
  margin: number;
  vendor: number;
  quotation: number;
  comments: number;
}

const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * The header row, by position: ITEMS, DAYS and TOTAL AED each appear twice, so
 * the cost block is the three cells after ACT COST and the billed block the
 * three after PER UNIT.
 */
function findColumns(row: string[]): Columns | null {
  const cells = row.map(norm);
  const costUnit = cells.indexOf("ACT COST");
  const billedUnit = cells.indexOf("PER UNIT");
  if (cells[0] !== "SUBJECT" || costUnit < 0 || billedUnit < 0 || billedUnit < costUnit + 4) return null;
  const find = (name: string) => cells.indexOf(name);
  return {
    ref: 0,
    description: 1,
    type: find("TYPE"),
    costUnit,
    billedUnit,
    margin: find("MARGIN"),
    vendor: find("VENDOR"),
    quotation: find("QUOTATION"),
    comments: find("COMMENTS"),
  };
}

const SECTION_RE = /^\d{1,2}\s*-\s*\S/;
const REF_RE = /^\d+(\.\d+)+$/;
const TOTAL_RE = /^(sub\s*total|total)\b/i;
const CUMULATIVE_RE = /^(sub\s*total|total expenses\b)/i;

function typeOf(raw: string): SheetLineType {
  const t = raw.trim().toLowerCase();
  if (t === "internal") return "INTERNAL";
  if (t === "external") return "EXTERNAL";
  return null;
}

function cellAt(row: string[], i: number): string {
  return i < 0 ? "" : (row[i] ?? "").trim();
}

export function parseBudgetSheet(text: string): ParsedSheet {
  const rows = tokenise(text, detectDelimiter(text));
  const out: ParsedSheet = { title: "", lines: [], totals: [], footer: [], errors: [] };
  if (rows.length > SHEET_MAX_ROWS) {
    out.errors.push({ rowNum: 0, message: `The sheet has ${rows.length} rows; the limit is ${SHEET_MAX_ROWS}.` });
    return out;
  }
  const headerAt = rows.findIndex((r) => findColumns(r) !== null);
  if (headerAt < 0) {
    out.errors.push({ rowNum: 0, message: "No header row was found. A budget sheet starts its table with SUBJECT, ITEMS, TYPE, ACT COST ... PER UNIT ... MARGIN." });
    return out;
  }
  const cols = findColumns(rows[headerAt])!;
  out.title = rows.slice(0, headerAt).flat().map((c) => c.trim()).find(Boolean) ?? "";

  let section = "";
  let group: string | null = null;
  let sinceLastTotal: number[] = [];
  let pastGrandTotal = false;

  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    if (findColumns(row)) continue;
    const ref = cellAt(row, cols.ref);
    const description = cellAt(row, cols.description).replace(/\s+/g, " ");
    const nums = (start: number) => [0, 1, 2, 3].map((k) => parseAmount(row[start + k]));
    const cost = nums(cols.costUnit);
    const billed = nums(cols.billedUnit);
    const margin = parseAmount(row[cols.margin]);
    const anyNumber = [...cost, ...billed, margin].some((n) => n !== null);

    const bad = [...cost, ...billed, margin].some((n) => n !== null && Number.isNaN(n));
    if (bad && !pastGrandTotal) {
      out.errors.push({ rowNum, message: `Row ${rowNum} (${description || ref || "no description"}) has an amount that is not a number; the row was skipped.` });
      continue;
    }

    if (!pastGrandTotal && SECTION_RE.test(ref) && !anyNumber) {
      section = ref.replace(/\s+/g, " ");
      group = null;
      continue;
    }
    if (TOTAL_RE.test(description)) {
      const cumulative = CUMULATIVE_RE.test(description);
      out.totals.push({ rowNum, label: description, cumulative, cost: cost[3], billed: billed[3], margin, lineRows: cumulative ? [] : sinceLastTotal });
      if (!cumulative) sinceLastTotal = [];
      if (/^total expenses\b/i.test(description)) pastGrandTotal = true;
      continue;
    }
    if (pastGrandTotal) {
      // Below the grand total: loose figures, some labelled ("2025 Income").
      const cells = row.map((c) => c.trim()).filter(Boolean);
      const label = cells.find((c) => Number.isNaN(parseAmount(c) as number)) ?? "";
      const value = cells.map(parseAmount).find((n): n is number => n !== null && !Number.isNaN(n));
      if (value !== undefined) out.footer.push({ rowNum, label, value });
      continue;
    }
    if (!description && !ref) continue;
    if (!REF_RE.test(ref) && !anyNumber) {
      if (description) group = description;
      continue;
    }
    if (!description) {
      out.errors.push({ rowNum, message: `Row ${rowNum} has amounts but no description; it was skipped.` });
      continue;
    }

    const billedBlank = billed.every((n) => n === null);
    const contingency = /contingency/i.test(description) ? Number(/(\d+(?:\.\d+)?)\s*%/.exec(description)?.[1] ?? Number.NaN) : null;
    out.lines.push({
      rowNum,
      ref,
      section,
      group,
      description,
      type: typeOf(cellAt(row, cols.type)),
      cost: { unit: cost[0], items: cost[1] ?? 0, days: cost[2] ?? 0, total: cost[3] },
      billed: billedBlank ? null : { unit: billed[0], items: billed[1] ?? 0, days: billed[2] ?? 0, total: billed[3] },
      sheetMargin: margin,
      vendor: cellAt(row, cols.vendor),
      quotation: cellAt(row, cols.quotation),
      comments: cellAt(row, cols.comments).replace(/\s*\n\s*/g, "; "),
      contingencyPercent: contingency !== null && Number.isFinite(contingency) ? contingency : null,
    });
    sinceLastTotal.push(rowNum);
  }
  return out;
}

// ── planning ────────────────────────────────────────────────────────────────

export interface CatalogueProduct {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
}

/**
 * Description → catalogue SKU, first match wins, so the specific rules sit
 * above the general ones ("branding design" before "branding"). A suggestion
 * only: the preview shows it and a person may change it.
 */
const SKU_RULES: readonly [RegExp, string][] = [
  [/day delegate/i, "510401"],
  [/room rental|meeting room|breakout/i, "510402"],
  [/staging|\bav\b|audio|visual equipment/i, "510301"],
  [/branding design|artwork|brand identity/i, "500334"],
  [/branding|signage|photowall/i, "500315"],
  [/event management|onsite delivery/i, "510002"],
  [/registration counter/i, "510315"],
  [/poster panel|poster area/i, "510306"],
  [/web ?site/i, "500330"],
  [/newsletter|social media/i, "500359"],
  [/roll ?ups?|banner/i, "500301"],
  [/staff.*(ticket|flight)/i, "500403"],
  [/flight|air ?ticket|airfare/i, "510203"],
  [/faculty dinner/i, "500501"],
  [/gala|conference dinner|pre ?conference dinner/i, "500503"],
  [/airport transfer/i, "510204"],
  [/transfer/i, "500704"],
  [/staff accom/i, "500402"],
  [/accommodation|hotel/i, "510201"],
  [/frame/i, "500307"],
  [/certificate/i, "500104"],
  [/gift|giveaway/i, "500603"],
  [/speaker visa/i, "510208"],
  [/visa/i, "500401"],
  [/registration portal/i, "500207"],
  [/delegate pack/i, "500602"],
  [/speaker management/i, "510012"],
  [/badge|lanyard/i, "500201"],
  [/survey/i, "500105"],
  [/\bcme\b/i, "500102"],
  [/project manager|committee liaison/i, "510006"],
  [/marketing/i, "510004"],
  [/liaison/i, "510012"],
  [/pre ?registration/i, "510001"],
  [/operations|logistics/i, "510015"],
  [/accounting|finance/i, "510005"],
  [/photograph/i, "500309"],
  [/videograph|video/i, "500367"],
  [/live feed|live endoscopy|transmission|live stream/i, "510317"],
  [/roya?li?ty/i, "500806"],
  [/booth|stand build|exhibition/i, "510303"],
  [/per ?diem/i, "500404"],
  [/tissue|consumable/i, "500914"],
  [/tour/i, "510101"],
  [/bank charge/i, "500901"],
];

/** The income account a billed line's money belongs to, by the cost's account group and who delivers it. */
const INCOME_FOR_GROUP: Readonly<Record<string, { internal: string; external: string }>> = {
  "500100": { internal: "430001", external: "440001" },
  "500200": { internal: "430009", external: "440009" },
  "500300": { internal: "430006", external: "440009" },
  "500400": { internal: "430009", external: "440004" },
  "500500": { internal: "430008", external: "440005" },
  "500600": { internal: "430008", external: "440006" },
  "500700": { internal: "430008", external: "440010" },
  "500800": { internal: "430009", external: "440007" },
  "500900": { internal: "430007", external: "440008" },
  "510000": { internal: "430011", external: "440004" },
  "510100": { internal: "430004", external: "440008" },
  "510200": { internal: "430008", external: "440010" },
  "510300": { internal: "430009", external: "440003" },
  "510400": { internal: "430009", external: "440011" },
};
const INCOME_FOR_SKU: Readonly<Record<string, string>> = { "500901": "430007" };
const CONTINGENCY_INCOME_ACCOUNT = "430007";

export type SheetWarningKind =
  | "SUBTOTAL_MISMATCH"
  | "UNBILLED_COST"
  | "BILLED_BELOW_COST"
  | "QTY_MISMATCH"
  | "INTERNAL_COST_ZERO"
  | "QUOTED_NOT_ORDERED"
  | "BILLED_WITHOUT_COST"
  | "UNIT_TOTAL_MISMATCH"
  | "DUPLICATE_REF"
  | "MISSING_REF"
  | "MISSING_TYPE"
  | "UNMAPPED"
  | "RESULT_ON_FOOTER";

export interface SheetWarning {
  kind: SheetWarningKind;
  rowNum: number;
  message: string;
}

export interface PlannedSheetLine {
  rowNum: number;
  ref: string;
  section: string;
  description: string;
  type: SheetLineType;
  vendor: string;
  /** Default on for anything with a cost or a billed amount; off for a quote never ordered. */
  include: boolean;
  isContingency: boolean;
  productId: string | null;
  sku: string | null;
  /** Expense side: qty is items × days; unit is total ÷ qty, so qty × unit reproduces the sheet's TOTAL. */
  costQty: number;
  costUnit: number;
  costTotal: number;
  /** True when an internal line's quantity-0 cost was counted (opts.countInternalCost). */
  internalCostCounted: boolean;
  billedQty: number;
  billedUnit: number;
  billedTotal: number;
  incomeAccount: string | null;
  notes: string;
}

export interface SheetPlan {
  title: string;
  lines: PlannedSheetLine[];
  contingencyPercent: number | null;
  warnings: SheetWarning[];
  errors: ParsedSheet["errors"];
  footer: SheetFooterFigure[];
  totals: { cost: number; billed: number; margin: number; marginPercent: number | null };
}

export interface PlanOptions {
  products: readonly CatalogueProduct[];
  /** Count an internal line's cost even when the sheet set its quantity to 0 (owner, Oct 28 2026). */
  countInternalCost: boolean;
}

/**
 * Half away from zero, so -25.625% shows as -25.63% like +25.625% does. The
 * product is cut to 12 significant digits first: -2050 / 8000 × 100 is
 * -25.6249999... in binary floating point, which would otherwise round down.
 */
const roundTo = (n: number, scale: number) => (Math.sign(n) * Math.round(Number((Math.abs(n) * scale).toPrecision(12)))) / scale;
const round2 = (n: number) => roundTo(n, 100);
const round4 = (n: number) => roundTo(n, 10_000);
const aed = (n: number) => `${n < 0 ? "-" : ""}${Math.abs(round2(n)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const lineName = (l: { ref: string; description: string }) => (l.ref ? `${l.ref} ${l.description}` : l.description);

/** A catalogue product for a description: the rule table, then a whole-name match, else null. */
export function suggestProduct(description: string, products: readonly CatalogueProduct[]): CatalogueProduct | null {
  const active = products.filter((p) => p.isActive);
  const bySku = new Map(active.map((p) => [p.sku, p]));
  for (const [re, sku] of SKU_RULES) {
    if (re.test(description) && bySku.has(sku)) return bySku.get(sku)!;
  }
  const d = description.toLowerCase();
  return active.find((p) => d.includes(p.name.toLowerCase())) ?? null;
}

export function incomeAccountFor(sku: string | null, type: SheetLineType, isContingency: boolean): string | null {
  if (isContingency) return CONTINGENCY_INCOME_ACCOUNT;
  if (!sku) return null;
  if (INCOME_FOR_SKU[sku]) return INCOME_FOR_SKU[sku];
  const group = accountGroupCode(sku);
  const pair = group ? INCOME_FOR_GROUP[group] : undefined;
  if (!pair) return null;
  return type === "INTERNAL" ? pair.internal : pair.external;
}

function amountsOf(a: SheetAmounts): { qty: number; total: number; unit: number } {
  const qty = round4(a.items * a.days);
  const total = a.total ?? round2((a.unit ?? 0) * qty);
  const unit = qty > 0 ? round4(total / qty) : (a.unit ?? 0);
  return { qty, total, unit };
}

function quantityNote(a: SheetAmounts): string {
  return a.days > 1 ? `${a.items} × ${a.days} days` : "";
}

function noteFor(l: SheetLine): string {
  const parts = [
    `Sheet ${l.ref || "row " + l.rowNum}${l.section ? `, ${l.section}` : ""}`,
    quantityNote(l.cost),
    l.vendor ? `Vendor: ${l.vendor}` : "",
    l.quotation ? `(${l.quotation.toLowerCase()})` : "",
    l.comments,
  ];
  return parts.filter(Boolean).join(" · ").slice(0, 2000);
}

function quoteWord(quotation: string): string {
  const q = quotation.trim().toLowerCase();
  if (!q) return "a price";
  return /^[aeiou]/.test(q) ? `an ${q}` : `a ${q}`;
}

const sameItem = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

function planLine(l: SheetLine, opts: PlanOptions, warnings: SheetWarning[], all: readonly SheetLine[]): PlannedSheetLine {
  const isContingency = l.contingencyPercent !== null;
  const product = isContingency ? null : suggestProduct(l.description, opts.products);
  const sku = product?.sku ?? null;
  const cost = amountsOf(l.cost);
  const billed = l.billed ? amountsOf(l.billed) : { qty: 0, total: 0, unit: 0 };

  let internalCostCounted = false;
  if (!isContingency && l.type === "INTERNAL" && cost.qty === 0 && (l.cost.unit ?? 0) > 0) {
    const qty = billed.qty > 0 ? billed.qty : 1;
    if (opts.countInternalCost) {
      cost.qty = qty;
      cost.unit = l.cost.unit ?? 0;
      cost.total = round2(cost.unit * qty);
      internalCostCounted = true;
    }
    warnings.push({
      kind: "INTERNAL_COST_ZERO",
      rowNum: l.rowNum,
      message: `${lineName(l)}: the sheet lists a cost of AED ${aed(l.cost.unit ?? 0)} but a quantity of 0, so its margin shows 100%.${opts.countInternalCost ? " Counted here as cost." : ""}`,
    });
  }

  if (!isContingency && !internalCostCounted && cost.qty > 0 && l.cost.unit !== null && l.cost.total !== null) {
    // The unit is shown rounded; a gap beyond half a unit per item is a formula problem, not rounding.
    if (Math.abs(l.cost.unit * cost.qty - l.cost.total) > cost.qty * 0.5 + 1) {
      warnings.push({ kind: "UNIT_TOTAL_MISMATCH", rowNum: l.rowNum, message: `${lineName(l)}: ${aed(l.cost.unit)} × ${cost.qty} is not the sheet's total of ${aed(l.cost.total)}. The total was used.` });
    }
  }

  const ordered = cost.total > 0 || billed.total > 0 || internalCostCounted;
  if (!ordered && !isContingency) {
    warnings.push({ kind: "QUOTED_NOT_ORDERED", rowNum: l.rowNum, message: `${lineName(l)}: ${quoteWord(l.quotation)} of AED ${aed(l.cost.unit ?? 0)} per unit, but a quantity of 0. Left out; tick it to keep it as a placeholder.` });
  }
  if (!isContingency && cost.total > 0 && billed.total === 0) {
    warnings.push({ kind: "UNBILLED_COST", rowNum: l.rowNum, message: `${lineName(l)} costs AED ${aed(cost.total)} and bills nothing. The sheet's margin column leaves it out.` });
  }
  if (!isContingency && l.type !== "INTERNAL" && billed.total > 0 && cost.total === 0 && (l.cost.unit ?? 0) > 0) {
    const twin = all.find((o) => o !== l && sameItem(o.description, l.description) && (o.cost.total ?? 0) > 0);
    const where = twin ? ` The cost may be on ${lineName(twin)} (AED ${aed(twin.cost.total ?? 0)}, ${twin.vendor || "no vendor"}).` : "";
    warnings.push({ kind: "BILLED_WITHOUT_COST", rowNum: l.rowNum, message: `${lineName(l)} bills AED ${aed(billed.total)} but records no cost (quantity 0).${where}` });
  }
  if (billed.total > 0 && cost.total > billed.total) {
    warnings.push({ kind: "BILLED_BELOW_COST", rowNum: l.rowNum, message: `${lineName(l)} bills AED ${aed(billed.total)} against a cost of AED ${aed(cost.total)}: a loss of AED ${aed(cost.total - billed.total)}.` });
  }
  if (!isContingency && l.billed && cost.qty > 0 && billed.qty > 0 && cost.qty !== billed.qty && !internalCostCounted) {
    warnings.push({ kind: "QTY_MISMATCH", rowNum: l.rowNum, message: `${lineName(l)}: cost is for ${l.cost.items} × ${l.cost.days}, billing for ${l.billed.items} × ${l.billed.days}.` });
  }
  if (!isContingency && ordered && !product) {
    warnings.push({ kind: "UNMAPPED", rowNum: l.rowNum, message: `${lineName(l)}: no catalogue product matched. Pick one before creating the budget.` });
  }

  return {
    rowNum: l.rowNum,
    ref: l.ref,
    section: l.section,
    description: l.description.slice(0, 300),
    type: l.type,
    vendor: l.vendor,
    include: ordered || isContingency,
    isContingency,
    productId: product?.id ?? null,
    sku,
    costQty: cost.qty,
    costUnit: cost.unit,
    costTotal: cost.total,
    internalCostCounted,
    billedQty: billed.qty,
    billedUnit: billed.unit,
    billedTotal: billed.total,
    incomeAccount: billed.total > 0 ? incomeAccountFor(sku, l.type, isContingency) : null,
    notes: internalCostCounted ? `${noteFor(l)} · Internal cost counted (the sheet had quantity 0)` : noteFor(l),
  };
}

function sheetValue(l: SheetLine, field: "cost" | "billed" | "margin"): number {
  if (field === "cost") return l.cost.total ?? 0;
  if (field === "billed") return l.billed?.total ?? 0;
  return l.sheetMargin ?? 0;
}

/** A sheet total that disagrees with its lines, naming the one line that explains the gap when there is one. */
function checkTotal(t: SheetTotalRow, field: "cost" | "billed" | "margin", expected: number, covered: SheetLine[], warnings: SheetWarning[], suffix = "") {
  const stated = t[field];
  if (stated === null || Math.abs(stated - expected) <= 1) return;
  const gap = expected - stated;
  const value = (l: SheetLine) => sheetValue(l, field);
  const culprit = covered.find((l) => Math.abs(value(l) - gap) <= 1);
  const what = { cost: "cost", billed: "billed", margin: "margin" }[field];
  const because = culprit ? ` It leaves out ${lineName(culprit)} (AED ${aed(value(culprit))}).` : "";
  warnings.push({ kind: "SUBTOTAL_MISMATCH", rowNum: t.rowNum, message: `"${t.label}" states ${what} AED ${aed(stated)}; its lines add up to AED ${aed(expected)}.${because}${suffix}` });
}

/**
 * What the sheet says below its totals. Finance writes the income actually
 * agreed and the resulting profit there, unlabelled, plus last year's
 * expense and income: an unlabelled figure X with a second one equal to
 * X less the sheet's cost is read as income and result. Information only;
 * nothing below the totals becomes a line.
 */
function footerWarnings(sheet: ParsedSheet): SheetWarning[] {
  const grand = [...sheet.totals].reverse().find((t) => t.cumulative && t.cost !== null);
  if (!grand || grand.cost === null) return [];
  const sheetCost = grand.cost;
  const out: SheetWarning[] = [];
  const unlabelled = sheet.footer.filter((f) => f.label === "");
  const income = unlabelled.find((f) => unlabelled.some((g) => g !== f && Math.abs(f.value - sheetCost - g.value) <= 1));
  if (income) {
    const result = income.value - sheetCost;
    out.push({
      kind: "RESULT_ON_FOOTER",
      rowNum: income.rowNum,
      message: `Below the totals the sheet records income of AED ${aed(income.value)} and a result of AED ${aed(result)} (${round2((result / income.value) * 100)}%). The billed column (AED ${aed(grand.billed ?? 0)}) is the price, not what was earned.`,
    });
  }
  const priorExpense = sheet.footer.find((f) => /expense/i.test(f.label));
  const priorIncome = sheet.footer.find((f) => /income/i.test(f.label));
  if (income && priorExpense && priorIncome) {
    const pct = (now: number, then: number) => `${now >= then ? "+" : ""}${round2(((now - then) / then) * 100)}%`;
    const priorResult = priorIncome.value - priorExpense.value;
    const result = income.value - sheetCost;
    const year = /\d{4}/.exec(priorIncome.label)?.[0] ?? "last year";
    out.push({
      kind: "RESULT_ON_FOOTER",
      rowNum: priorIncome.rowNum,
      message: `Against ${year}: income ${pct(income.value, priorIncome.value)}, cost ${pct(sheetCost, priorExpense.value)}, result ${pct(result, priorResult)} (AED ${aed(priorResult)} then, AED ${aed(result)} now).`,
    });
  }
  return out;
}

export function planBudgetSheet(sheet: ParsedSheet, opts: PlanOptions): SheetPlan {
  const warnings: SheetWarning[] = [];
  const byRow = new Map(sheet.lines.map((l) => [l.rowNum, l]));

  // Subtotals: a section total against its own lines; a grand total against the sheet's own section totals.
  const sectionTotalsSoFar: SheetTotalRow[] = [];
  for (const t of sheet.totals) {
    if (t.cumulative) {
      const before = sheet.lines.filter((l) => l.rowNum < t.rowNum);
      const fromLines = { cost: before.reduce((s, l) => s + (l.cost.total ?? 0), 0), billed: before.reduce((s, l) => s + (l.billed?.total ?? 0), 0) };
      const fromTotals = (f: "cost" | "billed") => sectionTotalsSoFar.reduce((s, x) => s + (x[f] ?? 0), 0);
      for (const f of ["cost", "billed"] as const) {
        const offLines = Math.abs((t[f] ?? 0) - fromLines[f]) > 1;
        const explained = offLines && Math.abs((t[f] ?? 0) - fromTotals(f)) <= 1;
        checkTotal(t, f, offLines ? fromLines[f] : fromTotals(f), [], warnings, explained ? " The section totals above explain the gap." : "");
      }
      continue;
    }
    const covered = t.lineRows.map((r) => byRow.get(r)!).filter(Boolean);
    checkTotal(t, "cost", covered.reduce((s, l) => s + (l.cost.total ?? 0), 0), covered, warnings);
    checkTotal(t, "billed", covered.reduce((s, l) => s + (l.billed?.total ?? 0), 0), covered, warnings);
    checkTotal(t, "margin", covered.reduce((s, l) => s + (l.sheetMargin ?? 0), 0), covered, warnings);
    sectionTotalsSoFar.push(t);
  }

  const seen = new Map<string, number>();
  for (const l of sheet.lines) {
    if (!l.ref) warnings.push({ kind: "MISSING_REF", rowNum: l.rowNum, message: `"${l.description}" has no line number.` });
    else if (seen.has(l.ref)) warnings.push({ kind: "DUPLICATE_REF", rowNum: l.rowNum, message: `Line number ${l.ref} is used twice (rows ${seen.get(l.ref)} and ${l.rowNum}).` });
    else seen.set(l.ref, l.rowNum);
    if (!l.type && l.contingencyPercent === null && !/finance/i.test(l.section)) {
      warnings.push({ kind: "MISSING_TYPE", rowNum: l.rowNum, message: `${lineName(l)} has no type (Internal or External); treated as External.` });
    }
  }

  const lines = sheet.lines.map((l) => planLine(l, opts, warnings, sheet.lines));
  const contingency = sheet.lines.find((l) => l.contingencyPercent !== null)?.contingencyPercent ?? null;

  const included = lines.filter((l) => l.include);
  const cost = round2(included.filter((l) => !l.isContingency).reduce((s, l) => s + l.costTotal, 0));
  const billed = round2(included.reduce((s, l) => s + l.billedTotal, 0));
  warnings.push(...footerWarnings(sheet));
  warnings.sort((a, b) => a.rowNum - b.rowNum);
  return {
    title: sheet.title,
    lines,
    contingencyPercent: contingency,
    warnings,
    errors: sheet.errors,
    footer: sheet.footer,
    totals: { cost, billed, margin: round2(billed - cost), marginPercent: billed > 0 ? round2(((billed - cost) / billed) * 100) : null },
  };
}

/** Recompute the totals after the person changed lines on the preview. */
export function planTotals(lines: readonly PlannedSheetLine[]): SheetPlan["totals"] {
  const included = lines.filter((l) => l.include);
  const cost = round2(included.filter((l) => !l.isContingency).reduce((s, l) => s + l.costTotal, 0));
  const billed = round2(included.reduce((s, l) => s + l.billedTotal, 0));
  return { cost, billed, margin: round2(billed - cost), marginPercent: billed > 0 ? round2(((billed - cost) / billed) * 100) : null };
}

/** The contingency category code, re-exported so the page does not reach into the seed. */
export { CONTINGENCY_CATEGORY_CODE };
