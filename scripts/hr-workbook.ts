/**
 * Reads the UAE attendance workbook into plain data, and says whether the
 * balance engine reproduces it.
 *
 * Shared by the first import and by every later re-sync, so there is ONE
 * reading of the sheet and ONE statement of what "agrees with the workbook"
 * means. Pure: nothing in here opens a database, which is what lets the gate
 * run anywhere before anything is written.
 */
import type { LeaveCategory } from "@prisma/client";
import { Workbook, cell, excelSerialToDate } from "./hr-xlsx";
import { computeLeaveBalance, type BalanceEntry } from "../src/hr/lib/leave-balance";
import { HR_LEAVE_CODE_SEED } from "../src/hr/lib/hr-seed-data";
import { HR_DEFAULT_TIMEZONE } from "../src/hr/lib/hr-constants";
import { todayInTimezone, type CalendarDate } from "../src/hr/lib/hr-date";

/** The workbook is a 2026 tracker; its seeds are true for that year and no other. */
export const WORKBOOK_LEAVE_YEAR = 2026;

/** Rows that carry no information: the derived default the module does not store. */
export const DERIVABLE = new Set(["P", "OFF", "PH"]);

/** lower-cased code -> canonical seed code + category + weight ("Hajj" is written mixed-case). */
const CODE_MAP = new Map(
  HR_LEAVE_CODE_SEED.map((c) => [
    c.code.toLowerCase(),
    { code: c.code, category: c.countsAs as LeaveCategory, weight: c.dayWeight },
  ]),
);

export type SheetStatus = "ACTIVE" | "RESIGNED" | "TERMINATED";

export interface SheetEmployee {
  empCode: string;
  name: string;
  department: string | null;
  jobTitle: string | null;
  joiningDate: CalendarDate;
  exitDate: CalendarDate | null;
  status: SheetStatus;
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
  /** Employee Master G: the year's entitlement BEFORE carryover. Null when blank. */
  entitlement: number | null;
}

export interface WorkbookEntry extends BalanceEntry {
  /** Canonical seed code, e.g. "AL", "SL-HD", "Hajj". */
  code: string;
}

export interface SummaryRow {
  empCode: string;
  name: string;
  /** Leave Summary D. In the workbook this is `G + H`: entitlement PLUS carryover. */
  entitlement: number;
  /** False when someone typed over the formula, so D no longer follows G + H. */
  entitlementIsFormula: boolean;
  annualTaken: number;
  annualBalance: number;
  sickFull: number;
  odDays: number;
  compEarned: number;
  compTaken: number;
  compBalance: number;
}

export interface ParsedWorkbook {
  file: string;
  employees: SheetEmployee[];
  skippedEmployees: string[];
  entriesByEmp: Map<string, WorkbookEntry[]>;
  informative: number;
  derivable: number;
  unknownCodes: Map<string, number>;
  summary: SummaryRow[];
}

function n(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Text as a person meant it. The sheet carries trailing spaces ("Medical
 * Liaison Executive "), and the app trims on save, so a raw comparison reports
 * a difference no one can see.
 */
function text(value: string | null): string | null {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
}

/**
 * The sheet's Employment Status, reconciled with its Exit Date.
 *
 * The date is the fact and the word is a label that goes stale: the sheet
 * has said "Active" beside a last working day months in the past. A leaver
 * status with no date is passed through as typed, because the service refuses
 * exactly that pair and the refusal is the right report.
 */
export function statusFromSheet(
  status: string | null,
  exitDate: CalendarDate | null,
  today: CalendarDate,
): SheetStatus {
  const typed = (status ?? "").trim().toUpperCase();
  const recognised: SheetStatus | null =
    typed === "ACTIVE" ? "ACTIVE"
    : typed.startsWith("RESIGN") ? "RESIGNED"
    : typed.startsWith("TERMINAT") ? "TERMINATED"
    : null;
  if (exitDate && exitDate < today) {
    return recognised && recognised !== "ACTIVE" ? recognised : "RESIGNED";
  }
  return recognised ?? (exitDate ? "RESIGNED" : "ACTIVE");
}

export function parseHrWorkbook(
  file: string,
  opts: { today?: CalendarDate } = {},
): ParsedWorkbook {
  const today = opts.today ?? todayInTimezone(HR_DEFAULT_TIMEZONE);
  const wb = new Workbook(file);
  const names = wb.sheetNames();
  const sheet = (label: string) => {
    const i = names.indexOf(label);
    if (i === -1) throw new Error(`Sheet "${label}" not found in ${file}`);
    return i + 1;
  };

  // ---- Employee Master -----------------------------------------------------
  const employees: SheetEmployee[] = [];
  const skippedEmployees: string[] = [];
  for (const row of wb.rows(sheet("Employee Master")).slice(1)) {
    const empCode = cell(row, "A");
    const name = cell(row, "B");
    const joining = cell(row, "E");
    // EMP024 and EMP025 are placeholder rows: a numeric "name" and no joining
    // date. Creating employees from them is the phantom-row class the module
    // exists to avoid.
    if (!empCode || !name || /^\d+$/.test(name) || !joining) {
      if (empCode) skippedEmployees.push(empCode);
      continue;
    }
    const exitCell = cell(row, "L");
    const exitDate = exitCell ? excelSerialToDate(Number(exitCell)) : null;
    const entitlementCell = cell(row, "G");
    employees.push({
      empCode: empCode.trim(),
      name: name.trim(),
      department: text(cell(row, "C")),
      jobTitle: text(cell(row, "D")),
      joiningDate: excelSerialToDate(Number(joining)),
      exitDate,
      status: statusFromSheet(cell(row, "F"), exitDate, today),
      carryoverDays: n(cell(row, "H")),
      openingSickUsed: n(cell(row, "I")),
      openingCompOff: n(cell(row, "J")),
      entitlement: entitlementCell === null ? null : Number(entitlementCell),
    });
  }

  // ---- Daily Attendance ----------------------------------------------------
  const entriesByEmp = new Map<string, WorkbookEntry[]>();
  let informative = 0;
  let derivable = 0;
  const unknownCodes = new Map<string, number>();
  for (const row of wb.rows(sheet("Daily Attendance")).slice(1)) {
    const empCode = cell(row, "C");
    const serial = cell(row, "A");
    const code = cell(row, "F");
    if (!empCode || !serial || !code) continue;
    if (DERIVABLE.has(code.toUpperCase())) {
      derivable++;
      continue;
    }
    const mapped = CODE_MAP.get(code.toLowerCase());
    if (!mapped) {
      unknownCodes.set(code, (unknownCodes.get(code) ?? 0) + 1);
      continue;
    }
    informative++;
    const list = entriesByEmp.get(empCode) ?? [];
    list.push({
      date: excelSerialToDate(Number(serial)),
      code: mapped.code,
      category: mapped.category,
      dayWeight: mapped.weight,
    });
    entriesByEmp.set(empCode, list);
  }

  // ---- Leave Summary (the baseline we must reproduce) ----------------------
  const summary: SummaryRow[] = [];
  for (const row of wb.rows(sheet("Leave Summary")).slice(1)) {
    const empCode = cell(row, "A");
    const name = cell(row, "B");
    if (!empCode || !name || /^\d+$/.test(name)) continue;
    summary.push({
      empCode: empCode.trim(),
      name: name.trim(),
      entitlement: n(cell(row, "D")),
      entitlementIsFormula: Boolean(row.D?.f),
      annualTaken: n(cell(row, "E")),
      annualBalance: n(cell(row, "F")),
      sickFull: n(cell(row, "G")),
      odDays: n(cell(row, "S")),
      compEarned: n(cell(row, "T")),
      compTaken: n(cell(row, "U")),
      compBalance: n(cell(row, "V")),
    });
  }

  return { file, employees, skippedEmployees, entriesByEmp, informative, derivable, unknownCodes, summary };
}

export interface ReconcileRow {
  ok: boolean;
  empCode: string;
  name: string;
  annualTaken: number;
  annualBalance: number;
  sickFull: number;
  compEarned: number;
  compBalance: number;
}

export interface Variance {
  /**
   * expected: the one known difference (EMP002's Wed+Thu comp-off).
   * workbook-inconsistent: a summary cell was typed over its formula, so the
   *   sheet disagrees with ITSELF; the engine is compared against the formula.
   * unexpected: the engine does not reproduce the sheet. A bug, ours or theirs.
   */
  kind: "expected" | "workbook-inconsistent" | "unexpected";
  empCode: string;
  text: string;
}

export interface Reconciliation {
  rows: ReconcileRow[];
  matched: number;
  total: number;
  variances: Variance[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Feed the sheet's entries through the same pure engine the application uses
 * and compare against the sheet's own Leave Summary.
 *
 * Entitlement is taken from Employee Master G rather than recomputed, because
 * the gate tests the BALANCE MATHS, not the clock: the sheet's gate is
 * evaluated against TODAY() and moves. It is NOT taken from Leave Summary D,
 * which is `G + H`, entitlement plus carryover: adding our own carried-in
 * figure to that counts the carryover twice, and the double count was invisible
 * for as long as every H was 0.
 */
export function reconcile(parsed: ParsedWorkbook): Reconciliation {
  const rows: ReconcileRow[] = [];
  const variances: Variance[] = [];
  let matched = 0;

  for (const s of parsed.summary) {
    const e = parsed.employees.find((x) => x.empCode === s.empCode);
    if (!e) {
      variances.push({ kind: "unexpected", empCode: s.empCode, text: `${s.empCode}: in the summary but not in Employee Master` });
      continue;
    }
    const b = computeLeaveBalance({
      employee: {
        joiningDate: e.joiningDate,
        exitDate: e.exitDate,
        carryoverDays: e.carryoverDays,
        openingSickUsed: e.openingSickUsed,
        openingCompOff: e.openingCompOff,
      },
      leaveYear: WORKBOOK_LEAVE_YEAR,
      asOf: `${WORKBOOK_LEAVE_YEAR}-12-31`,
      entries: parsed.entriesByEmp.get(s.empCode) ?? [],
    });

    const masterEntitlement = e.entitlement ?? s.entitlement - e.carryoverDays;
    const ourBalance = round1(masterEntitlement + b.annual.carriedIn - b.annual.taken);

    // What the summary's own formula gives. When D was typed over, the sheet
    // contradicts itself; say so, and hold the engine to the formula.
    const formulaEntitlement = round1(masterEntitlement + e.carryoverDays);
    let sheetBalance = s.annualBalance;
    if (!s.entitlementIsFormula && s.entitlement !== formulaEntitlement) {
      sheetBalance = round1(formulaEntitlement - s.annualTaken);
      variances.push({
        kind: "workbook-inconsistent",
        empCode: s.empCode,
        text: `${s.empCode} ${s.name}: Leave Summary entitlement is typed as ${s.entitlement} where its formula gives ${formulaEntitlement}. Not applied. Record an agreed entitlement in the app if it is intended.`,
      });
    }

    const diffs: string[] = [];
    if (b.annual.taken !== s.annualTaken) diffs.push(`AL taken ${b.annual.taken} vs ${s.annualTaken}`);
    if (ourBalance !== sheetBalance) diffs.push(`AL balance ${ourBalance} vs ${sheetBalance}`);
    if (b.sick.full.used !== s.sickFull) diffs.push(`sick full ${b.sick.full.used} vs ${s.sickFull}`);
    if (b.compOff.earned !== s.compEarned) diffs.push(`comp earned ${b.compOff.earned} vs ${s.compEarned}`);
    if (b.compOff.taken !== s.compTaken) diffs.push(`comp taken ${b.compOff.taken} vs ${s.compTaken}`);

    const ok = diffs.length === 0;
    rows.push({
      ok,
      empCode: s.empCode,
      name: s.name,
      annualTaken: b.annual.taken,
      annualBalance: ourBalance,
      sickFull: b.sick.full.used,
      compEarned: b.compOff.earned,
      compBalance: b.compOff.balance,
    });
    if (ok) {
      matched++;
      continue;
    }
    const text = `${s.empCode} ${s.name}: ${diffs.join("; ")}`;
    // The single KNOWN variance, per docs/HR_MODULE_PLAN.md §3.2.
    const expected = s.empCode === "EMP002" && diffs.length === 1 && diffs[0].startsWith("comp earned");
    variances.push({ kind: expected ? "expected" : "unexpected", empCode: s.empCode, text });
  }

  return { rows, matched, total: parsed.summary.length, variances };
}
