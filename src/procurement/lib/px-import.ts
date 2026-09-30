/**
 * The ProcurementExpress history reader (docs/BUDGET_AI_PLAN.md section 2a;
 * owner, Sep 30, 2026: "use this as baseline"). Two pure halves, no database,
 * so every rule is testable from a string (the catalogue-import pattern):
 *
 *   parsePxLineExport  reads PX's LINE-LEVEL purchase order report into typed
 *                      lines and reports every row it could not read. The
 *                      columns that carry personal data (Notes, Narration,
 *                      Submitter, Approvers) are never read, so they cannot
 *                      travel further than this function.
 *   planPxImport       applies the import rules: which statuses count, the
 *                      event each line belongs to, its budget category, the
 *                      committed and paid amounts in AED ex-VAT, and every
 *                      warning a person must see in the preview.
 *
 * Nothing here decides who may load history or writes anything; the loader
 * that stores a plan is stage 1's service, built once finance's full export
 * and budget sheets arrive.
 *
 * Client-safe: no Node imports.
 */
import { parseCSV } from "@/lib/csv-parser";
import { accountGroupCode } from "./budget-categories-seed";

/** Far above one organisation's full PX history (the Jan to Jul 2025 file held 641 lines). */
export const PX_MAX_ROWS = 50_000;

/** The statuses whose lines count as spend. Everything else is dropped and counted. */
const COUNTED_STATUSES = new Set(["approved", "paid"]);

/** An order that PX marks paid but whose lines record nothing paid is committed, not paid (plan 2a.3). */
export type PxEvidence = "committed" | "paid";

/** Columns the reader needs, by the header text PX writes. */
const REQUIRED = {
  poId: "Purchase-Order-ID",
  lineNo: "Purchase-Order-Line#",
  date: "Date",
  status: "Status",
  currency: "PO-Currency",
  sku: "Item-Number-SKU",
  description: "Description",
  aedNet: "AED-Net-Amount",
  grossPoCcy: "Gross-Amount-in-PO-ccy",
  netPoCcy: "Net-Amount-in-PO-ccy",
  budget: "Budget",
  totalPaid: "Total-Paid-Amount",
} as const;

const OPTIONAL = {
  poNumber: "PO-Number",
  supplier: "Supplier",
  quantity: "Quantity",
  unitPrice: "Unit-Price-in-PO-ccy",
  taxPercent: "Tax%",
  aedGross: "AED-Gross-Amount",
  paymentDate: "Payment-Date",
  qbClass: "QuickBooks Class",
} as const;

type ColumnKey = keyof typeof REQUIRED | keyof typeof OPTIONAL;

export interface PxLine {
  rowNum: number;
  poId: string;
  lineNo: string;
  poNumber: string;
  /** YYYY-MM-DD */
  date: string;
  /** Lowercased: PX writes both "paid" and "Paid". */
  status: string;
  currency: string;
  sku: string;
  description: string;
  supplier: string;
  quantity: number | null;
  unitPrice: number | null;
  taxPercent: number | null;
  grossPoCcy: number;
  netPoCcy: number;
  aedGross: number | null;
  aedNet: number;
  /** Gross, in the order's own currency, as PX records it. */
  totalPaid: number;
  paymentDate: string | null;
  /** One or more event names from the Budget cell, cleaned for display. */
  budgetNames: string[];
  qbClass: string;
}

export interface PxRowError {
  rowNum: number;
  message: string;
}

export interface PxParseResult {
  lines: PxLine[];
  errors: PxRowError[];
  /** Earliest and latest order date in the file; null when no line was read. */
  range: { from: string; to: string } | null;
  fatal?: string;
}

/** Header names are matched after trimming, lowercasing and dropping spaces, underscores and dashes. */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A PX amount cell: "11620", "1,499.99", "AED 11620.0", "-510", "(510.00)".
 * A leading three-letter currency code is stripped; anything else that is not
 * a number is refused (null), never read as zero. The empty cell is null too.
 */
export function parsePxAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^[A-Z]{3}\s+/, "");
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(s);
  if (bracketed) {
    negative = true;
    s = bracketed[1].trim();
  }
  s = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

/** The display form of one event name: trimmed, inner whitespace collapsed. */
function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The key an event name is mapped by, so trivial spelling differences in PX's
 * Budget cell map once: case, spacing, a dash before the year ("Forum - 2025"
 * vs "Forum 2025") and the en dash PX sometimes writes.
 */
export function pxEventKey(raw: string): string {
  return cleanName(raw)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*(?=\d{4}\b)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first four-digit year in an event name, if any ("MEHFC 2025" is 2025). */
export function pxEventYear(raw: string): number | null {
  const m = /\b(20\d{2})\b/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** The six-digit account code at the start of a PX SKU cell ("510203 Speaker Air Ticket" is 510203). */
export function pxAccountCode(sku: string): string | null {
  const m = /^\s*(\d{6})\b/.exec(sku);
  return m ? m[1] : null;
}

export function parsePxLineExport(text: string): PxParseResult {
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) return { lines: [], errors: [], range: null, fatal: "The file is empty." };
  const parsed = parseCSV(body, { maxRows: PX_MAX_ROWS });
  if (parsed.error) return { lines: [], errors: [], range: null, fatal: parsed.error };

  const headers = parsed.headers.map(normalizeHeader);
  const index = new Map<ColumnKey, number>();
  const missing: string[] = [];
  for (const [key, name] of Object.entries(REQUIRED) as [ColumnKey, string][]) {
    const i = headers.indexOf(normalizeHeader(name));
    if (i < 0) missing.push(name);
    else index.set(key, i);
  }
  if (missing.length) {
    const orderLevel = headers.includes(normalizeHeader("AED-Total-Net"));
    const fatal = orderLevel
      ? "This is ProcurementExpress's order-level report. Export the line-level purchase order report instead (it has Purchase-Order-Line# and Item-Number-SKU columns)."
      : `This is not a ProcurementExpress line-level export. Missing columns: ${missing.join(", ")}.`;
    return { lines: [], errors: [], range: null, fatal };
  }
  for (const [key, name] of Object.entries(OPTIONAL) as [ColumnKey, string][]) {
    const i = headers.indexOf(normalizeHeader(name));
    if (i >= 0) index.set(key, i);
  }

  const lines: PxLine[] = [];
  const errors: PxRowError[] = [];
  const seen = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;

  parsed.rows.forEach((fields, i) => {
    const rowNum = i + 2; // the header is row 1
    const get = (k: ColumnKey): string => {
      const at = index.get(k);
      return at === undefined ? "" : (fields[at] ?? "").trim();
    };
    const line = readLine(rowNum, get);
    if ("message" in line) {
      errors.push(line);
      return;
    }
    const identity = `${line.poId}#${line.lineNo}`;
    if (seen.has(identity)) {
      errors.push({ rowNum, message: `Order ${line.poId} line ${line.lineNo} appears twice in the file.` });
      return;
    }
    seen.add(identity);
    lines.push(line);
    if (!from || line.date < from) from = line.date;
    if (!to || line.date > to) to = line.date;
  });

  return { lines, errors, range: from && to ? { from, to } : null };
}

function readLine(rowNum: number, get: (k: ColumnKey) => string): PxLine | PxRowError {
  const poId = get("poId");
  const lineNo = get("lineNo");
  if (!poId || !lineNo) return { rowNum, message: "No order id or line number." };

  const date = get("date").slice(0, 10);
  if (!ISO_DATE_RE.test(date)) return { rowNum, message: `Order ${poId}: the date "${get("date")}" is not YYYY-MM-DD.` };

  const amounts = {
    aedNet: parsePxAmount(get("aedNet")),
    grossPoCcy: parsePxAmount(get("grossPoCcy")),
    netPoCcy: parsePxAmount(get("netPoCcy")),
    totalPaid: parsePxAmount(get("totalPaid")) ?? (get("totalPaid") === "" ? 0 : null),
  };
  for (const [key, value] of Object.entries(amounts)) {
    if (value !== null) continue;
    const column = REQUIRED[key as keyof typeof REQUIRED];
    return { rowNum, message: `Order ${poId} line ${lineNo}: ${column} "${get(key as ColumnKey)}" is not an amount.` };
  }

  const budgetNames = get("budget")
    .split(",")
    .map(cleanName)
    .filter(Boolean);
  const paymentDate = get("paymentDate").slice(0, 10);

  return {
    rowNum,
    poId,
    lineNo,
    poNumber: get("poNumber"),
    date,
    status: get("status").toLowerCase(),
    currency: get("currency").toUpperCase(),
    sku: get("sku"),
    description: get("description"),
    supplier: cleanName(get("supplier")),
    quantity: parsePxAmount(get("quantity")),
    unitPrice: parsePxAmount(get("unitPrice")),
    taxPercent: parsePxAmount(get("taxPercent")),
    grossPoCcy: amounts.grossPoCcy as number,
    netPoCcy: amounts.netPoCcy as number,
    aedGross: parsePxAmount(get("aedGross")),
    aedNet: amounts.aedNet as number,
    totalPaid: amounts.totalPaid as number,
    paymentDate: ISO_DATE_RE.test(paymentDate) ? paymentDate : null,
    budgetNames,
    qbClass: get("qbClass"),
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** What an event name in PX's Budget cell has been mapped to (stored per organisation once built). */
export type PxEventTarget =
  | { kind: "event"; id: string; label: string; /** YYYY-MM-DD, when known */ startDate?: string | null }
  | { kind: "not-event" };

export type PxLineFlag =
  | "shared" // the line named more than one event and was split
  | "vat-unclear" // a tax rate is set but the order-currency gross equals net
  | "class-mismatch" // QuickBooks Class names a different year than the Budget cell
  | "credit"; // a negative line

export interface PxPlannedLine {
  rowNum: number;
  poId: string;
  lineNo: string;
  poNumber: string;
  date: string;
  eventKey: string;
  eventName: string;
  /** The account group (category code), or null when unmapped. */
  categoryCode: string | null;
  /** For an unmapped line: the category most of the order's other lines carry, for a person to confirm. */
  suggestedCategoryCode: string | null;
  accountCode: string | null;
  description: string;
  /** "Individual (speaker)" for an unregistered supplier of a speakers-and-faculty line (plan 2a.4). */
  supplier: string;
  currency: string;
  /** PX's own rate for this line: AED net / net in the order currency. Null for a zero-value line. */
  rateToAed: number | null;
  /** AED ex-VAT, this event's share of the line. */
  committedAed: number;
  /** AED ex-VAT that PX records as paid, this event's share; 0 when evidence is committed. */
  paidAed: number;
  evidence: PxEvidence;
  flags: PxLineFlag[];
}

export interface PxEventSummary {
  eventKey: string;
  eventName: string;
  target: PxEventTarget | null;
  lineCount: number;
  committedAed: number;
  paidAed: number;
  /** paidAed / committedAed, 0..1; null when nothing was committed. */
  paidShare: number | null;
  /** Per category code ("UNMAPPED" for lines with none). */
  byCategory: Record<string, { committedAed: number; paidAed: number; lines: number }>;
  /** Whether the file covers the event whole (plan 2a.2 rule 7). */
  coverage: "complete" | "partial" | "unknown";
  coverageReason: string | null;
}

export interface PxPossibleDuplicate {
  eventKey: string;
  supplier: string;
  aedNet: number;
  poIds: string[];
}

export interface PxImportPlan {
  lines: PxPlannedLine[];
  events: PxEventSummary[];
  /** Event names in the file with no mapping yet, with their size, largest first. */
  unmappedEvents: { eventKey: string; eventName: string; lines: number; committedAed: number }[];
  dropped: {
    /** Lines whose status does not count, by status. */
    byStatus: Record<string, number>;
    /** Counted lines under an account outside the event cost groups (6xxxxx overheads, 22xxxx balance sheet). */
    notEventSpend: number;
    /** Counted lines mapped to Not an event (office spend such as MME). */
    notAnEvent: number;
    /** Counted lines with an empty Budget cell. */
    noEvent: number;
  };
  possibleDuplicates: PxPossibleDuplicate[];
  range: { from: string; to: string } | null;
}

/** An event is complete only when the file starts this long before it and ends this long after. */
export const PX_COVERAGE_LEAD_MONTHS = 12;
export const PX_COVERAGE_TAIL_MONTHS = 3;

const UNMAPPED = "UNMAPPED";
const SPEAKER_GROUP = "510200";
export const INDIVIDUAL_SUPPLIER_LABEL = "Individual (speaker)";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * The paid share of a line in AED ex-VAT. PX records payment gross, in the
 * order's currency; the ratio to the order-currency gross carries it across.
 * Capped at the whole line (rounding overpays by a few cents in the sample).
 */
function paidAedFor(line: PxLine): number {
  const gross = vatUnclear(line) ? line.netPoCcy * (1 + (line.taxPercent as number) / 100) : line.grossPoCcy;
  if (line.totalPaid === 0 || gross === 0) return 0;
  const ratio = Math.min(1, Math.max(0, line.totalPaid / gross));
  return line.aedNet * ratio;
}

/**
 * A tax rate is set but the order-currency gross equals net (7 lines in the
 * Jan to Jul 2025 file; PX's AED gross did add the tax). The amount used is
 * AED net either way; the flag tells a person the VAT figure is unreliable.
 */
function vatUnclear(line: PxLine): boolean {
  return (line.taxPercent ?? 0) > 0 && line.netPoCcy !== 0 && line.grossPoCcy === line.netPoCcy;
}

function coverageOf(
  target: PxEventTarget | null,
  eventName: string,
  range: { from: string; to: string } | null,
): { coverage: PxEventSummary["coverage"]; reason: string | null } {
  if (!range) return { coverage: "unknown", reason: null };
  const start = target?.kind === "event" ? target.startDate ?? null : null;
  if (start) {
    if (addMonths(start, -PX_COVERAGE_LEAD_MONTHS) < range.from) {
      return { coverage: "partial", reason: `The file starts ${range.from}, less than ${PX_COVERAGE_LEAD_MONTHS} months before the event.` };
    }
    if (addMonths(start, PX_COVERAGE_TAIL_MONTHS) > range.to) {
      return { coverage: "partial", reason: `The file ends ${range.to}, less than ${PX_COVERAGE_TAIL_MONTHS} months after the event.` };
    }
    return { coverage: "complete", reason: null };
  }
  const year = pxEventYear(eventName);
  if (year !== null && year < Number(range.from.slice(0, 4))) {
    return { coverage: "partial", reason: `A ${year} event in a file that starts ${range.from}.` };
  }
  return { coverage: "unknown", reason: "The event's date is not known, so the file's coverage cannot be checked." };
}

export function planPxImport(
  parsed: Pick<PxParseResult, "lines" | "range">,
  opts: {
    /** Keyed by pxEventKey. */
    eventMap: ReadonlyMap<string, PxEventTarget>;
    /** Supplier names (any case) held as supplier records; others on speaker lines are anonymised. */
    knownSuppliers?: ReadonlySet<string>;
  },
): PxImportPlan {
  const known = new Set([...(opts.knownSuppliers ?? [])].map((s) => s.trim().toLowerCase()));
  const byStatus: Record<string, number> = {};
  let notEventSpend = 0;
  let notAnEvent = 0;
  let noEvent = 0;
  const planned: PxPlannedLine[] = [];
  const displayName = new Map<string, string>();

  const counted = parsed.lines.filter((l) => {
    if (COUNTED_STATUSES.has(l.status)) return true;
    const key = l.status || "(blank)";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    return false;
  });

  // The category most of each order's mapped lines carry, for the unmapped fee lines on it.
  const orderCategories = new Map<string, Map<string, number>>();
  for (const l of counted) {
    const code = accountCodeGroup(l);
    if (!code) continue;
    const m = orderCategories.get(l.poId) ?? new Map<string, number>();
    m.set(code, (m.get(code) ?? 0) + Math.abs(l.aedNet));
    orderCategories.set(l.poId, m);
  }

  for (const l of counted) {
    const accountCode = pxAccountCode(l.sku);
    const categoryCode = accountCodeGroup(l);
    if (accountCode && !categoryCode) {
      notEventSpend++;
      continue;
    }
    if (l.budgetNames.length === 0) {
      noEvent++;
      continue;
    }

    const share = 1 / l.budgetNames.length;
    const paidTotal = paidAedFor(l);
    const evidence: PxEvidence = paidTotal !== 0 ? "paid" : "committed";
    const baseFlags: PxLineFlag[] = [];
    if (l.budgetNames.length > 1) baseFlags.push("shared");
    if (vatUnclear(l)) baseFlags.push("vat-unclear");
    if (l.aedNet < 0) baseFlags.push("credit");

    for (const name of l.budgetNames) {
      const eventKey = pxEventKey(name);
      if (!displayName.has(eventKey)) displayName.set(eventKey, name);
      if (opts.eventMap.get(eventKey)?.kind === "not-event") {
        notAnEvent++;
        continue;
      }
      const flags = [...baseFlags];
      const classYear = pxEventYear(l.qbClass);
      const nameYear = pxEventYear(name);
      if (classYear !== null && nameYear !== null && classYear !== nameYear) flags.push("class-mismatch");

      const isIndividual = categoryCode === SPEAKER_GROUP && !known.has(l.supplier.toLowerCase());
      planned.push({
        rowNum: l.rowNum,
        poId: l.poId,
        lineNo: l.lineNo,
        poNumber: l.poNumber,
        date: l.date,
        eventKey,
        eventName: displayName.get(eventKey) as string,
        categoryCode,
        suggestedCategoryCode: categoryCode ? null : dominant(orderCategories.get(l.poId)),
        accountCode,
        description: l.description,
        supplier: isIndividual ? INDIVIDUAL_SUPPLIER_LABEL : l.supplier,
        currency: l.currency,
        rateToAed: l.netPoCcy !== 0 ? round2((l.aedNet / l.netPoCcy) * 10_000) / 10_000 : null,
        committedAed: round2(l.aedNet * share),
        paidAed: round2(paidTotal * share),
        evidence,
        flags,
      });
    }
  }

  const events = summarise(planned, opts.eventMap, parsed.range);
  const unmappedEvents = events
    .filter((e) => e.target === null)
    .map((e) => ({ eventKey: e.eventKey, eventName: e.eventName, lines: e.lineCount, committedAed: e.committedAed }))
    .sort((a, b) => b.committedAed - a.committedAed);

  return {
    lines: planned,
    events,
    unmappedEvents,
    dropped: { byStatus, notEventSpend, notAnEvent, noEvent },
    possibleDuplicates: findDuplicates(planned),
    range: parsed.range,
  };
}

/** The line's category, only when its account code is a cost account. */
function accountCodeGroup(l: PxLine): string | null {
  const code = pxAccountCode(l.sku);
  return code ? accountGroupCode(code) : null;
}

function dominant(m: Map<string, number> | undefined): string | null {
  if (!m || m.size === 0) return null;
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function summarise(
  lines: PxPlannedLine[],
  eventMap: ReadonlyMap<string, PxEventTarget>,
  range: { from: string; to: string } | null,
): PxEventSummary[] {
  const byKey = new Map<string, PxEventSummary>();
  for (const l of lines) {
    let s = byKey.get(l.eventKey);
    if (!s) {
      const target = eventMap.get(l.eventKey) ?? null;
      const cov = coverageOf(target, l.eventName, range);
      s = {
        eventKey: l.eventKey,
        eventName: l.eventName,
        target,
        lineCount: 0,
        committedAed: 0,
        paidAed: 0,
        paidShare: null,
        byCategory: {},
        coverage: cov.coverage,
        coverageReason: cov.reason,
      };
      byKey.set(l.eventKey, s);
    }
    s.lineCount++;
    s.committedAed += l.committedAed;
    s.paidAed += l.paidAed;
    const cat = l.categoryCode ?? UNMAPPED;
    const c = s.byCategory[cat] ?? { committedAed: 0, paidAed: 0, lines: 0 };
    c.committedAed = round2(c.committedAed + l.committedAed);
    c.paidAed = round2(c.paidAed + l.paidAed);
    c.lines++;
    s.byCategory[cat] = c;
  }
  return [...byKey.values()]
    .map((s) => ({
      ...s,
      committedAed: round2(s.committedAed),
      paidAed: round2(s.paidAed),
      paidShare: s.committedAed > 0 ? Math.min(1, round2(s.paidAed / s.committedAed)) : null,
    }))
    .sort((a, b) => b.committedAed - a.committedAed);
}

/**
 * Counted lines on DIFFERENT orders with the same event, supplier and amount:
 * the cancel-and-revise pattern after the cancelled copy was dropped, or two
 * genuine purchases. Shown for a person to decide; never removed by code.
 * Individual (speaker) lines are left out: many speakers are paid the same fee.
 */
function findDuplicates(lines: PxPlannedLine[]): PxPossibleDuplicate[] {
  const groups = new Map<string, { line: PxPlannedLine; poIds: Set<string> }>();
  for (const l of lines) {
    if (l.supplier === INDIVIDUAL_SUPPLIER_LABEL || !l.supplier || l.committedAed === 0) continue;
    const key = `${l.eventKey}|${l.supplier.toLowerCase()}|${l.committedAed}`;
    const g = groups.get(key) ?? { line: l, poIds: new Set<string>() };
    g.poIds.add(l.poId);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.poIds.size > 1)
    .map((g) => ({ eventKey: g.line.eventKey, supplier: g.line.supplier, aedNet: g.line.committedAed, poIds: [...g.poIds].sort() }))
    .sort((a, b) => b.aedNet - a.aedNet);
}
