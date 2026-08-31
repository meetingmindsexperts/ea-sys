/**
 * What a re-sync of the workbook would change, decided without a database.
 *
 * The rule the whole file exists for: THE APP WINS WHERE A PERSON EDITED IT.
 * The workbook is re-sent with more data while the same people are also
 * recording in the app, so the two diverge in both directions. A field a
 * person changed in the app after the import is a decision; a workbook that
 * still holds the old value is merely stale. Such a field is reported as a
 * conflict and never overwritten. There is deliberately no force flag: the
 * place to overrule a decision is the employee's page, by a person.
 *
 * Attendance follows the same rule through `source`: a day the app recorded
 * (or re-coded, which flips the row to "ui") is app-owned; only rows the
 * import wrote may be changed or removed by a sync.
 */
import { addDays, type CalendarDate } from "../src/hr/lib/hr-date";

export const EMPLOYEE_SYNC_FIELDS = [
  "name",
  "department",
  "jobTitle",
  "joiningDate",
  "exitDate",
  "status",
  "carryoverDays",
  "openingSickUsed",
  "openingCompOff",
] as const;
export type EmployeeSyncField = (typeof EMPLOYEE_SYNC_FIELDS)[number];

export interface EmployeeSyncValues {
  name: string;
  department: string | null;
  jobTitle: string | null;
  joiningDate: CalendarDate;
  exitDate: CalendarDate | null;
  status: string;
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
}

export interface FieldConflict {
  field: EmployeeSyncField;
  app: unknown;
  workbook: unknown;
}

export interface EmployeePlan {
  patch: Partial<EmployeeSyncValues>;
  conflicts: FieldConflict[];
}

/**
 * Two values that differ only in surrounding whitespace are the same value.
 * The import wrote the sheet's trailing spaces, the app trims on save, and
 * without this the first save of an untouched field reads as a decision.
 */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

export function planEmployeeSync(
  app: EmployeeSyncValues,
  workbook: EmployeeSyncValues,
  appEdited: ReadonlySet<EmployeeSyncField>,
): EmployeePlan {
  const patch: Record<string, unknown> = {};
  const conflicts: FieldConflict[] = [];
  for (const field of EMPLOYEE_SYNC_FIELDS) {
    const a = app[field];
    const w = workbook[field];
    if (same(a, w)) continue;
    if (appEdited.has(field)) {
      conflicts.push({ field, app: a, workbook: w });
      continue;
    }
    patch[field] = w;
  }
  return { patch: patch as Partial<EmployeeSyncValues>, conflicts };
}

function isSyncField(key: string): key is EmployeeSyncField {
  return (EMPLOYEE_SYNC_FIELDS as readonly string[]).includes(key);
}

/**
 * The fields a person changed in the app, read from the employee's audit rows
 * written after the import.
 *
 * Two audit shapes exist: the original `{ before, after }` full snapshots and
 * the field diff `{ changed: { field: { from, to } | "changed" } }` that
 * replaced it (review M7). A row stamped `source: "import"` was written by a
 * sync and is the workbook speaking, not a person, so it establishes nothing.
 */
export function appEditedFields(auditChanges: readonly unknown[]): Set<EmployeeSyncField> {
  const out = new Set<EmployeeSyncField>();
  for (const raw of auditChanges) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { source?: unknown; changed?: unknown; before?: unknown; after?: unknown };
    if (c.source === "import") continue;
    if (c.changed && typeof c.changed === "object") {
      for (const key of Object.keys(c.changed)) if (isSyncField(key)) out.add(key);
      continue;
    }
    if (c.before && c.after && typeof c.before === "object" && typeof c.after === "object") {
      const before = c.before as Record<string, unknown>;
      const after = c.after as Record<string, unknown>;
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!isSyncField(key) || same(before[key], after[key])) continue;
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.add(key);
      }
    }
  }
  return out;
}

export interface AppEntry {
  date: CalendarDate;
  code: string;
  /** "ui" | "mcp" | "import" | "cron" */
  source: string;
}

export interface WorkbookDay {
  date: CalendarDate;
  code: string;
}

export interface EntryPlan {
  add: WorkbookDay[];
  change: { date: CalendarDate; from: string; to: string }[];
  remove: WorkbookDay[];
  /** Recorded in the app, absent from the workbook: kept, and reported. */
  appOnly: WorkbookDay[];
  /** Recorded in the app with one code, in the workbook with another: kept, and reported. */
  conflicts: { date: CalendarDate; app: string; workbook: string }[];
}

/** Every row the import did not write belongs to the app. */
export function isAppOwned(entry: { source: string }): boolean {
  return entry.source !== "import";
}

const byDate = <T extends { date: CalendarDate }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function planEntrySync(app: AppEntry[], workbook: WorkbookDay[]): EntryPlan {
  const plan: EntryPlan = { add: [], change: [], remove: [], appOnly: [], conflicts: [] };
  const appByDate = new Map(app.map((e) => [e.date, e]));
  const workbookDates = new Set(workbook.map((w) => w.date));

  for (const w of workbook) {
    const a = appByDate.get(w.date);
    if (!a) {
      plan.add.push(w);
      continue;
    }
    if (a.code === w.code) continue;
    if (isAppOwned(a)) plan.conflicts.push({ date: w.date, app: a.code, workbook: w.code });
    else plan.change.push({ date: w.date, from: a.code, to: w.code });
  }
  for (const a of app) {
    if (workbookDates.has(a.date)) continue;
    if (isAppOwned(a)) plan.appOnly.push({ date: a.date, code: a.code });
    else plan.remove.push({ date: a.date, code: a.code });
  }
  plan.add.sort(byDate);
  plan.change.sort(byDate);
  plan.remove.sort(byDate);
  plan.appOnly.sort(byDate);
  plan.conflicts.sort(byDate);
  return plan;
}

export interface DayRun {
  from: CalendarDate;
  to: CalendarDate;
  code: string;
}

/**
 * Consecutive calendar days with the same code, folded into ranges, so a
 * fortnight of leave is one service call rather than fourteen. A gap of even
 * one day starts a new run: a range must never reach a day that was not
 * listed, because the clear path deletes everything inside its range.
 */
export function contiguousRuns(days: readonly WorkbookDay[]): DayRun[] {
  const sorted = [...days].sort(byDate);
  const runs: DayRun[] = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.code === day.code && addDays(last.to, 1) === day.date) {
      last.to = day.date;
      continue;
    }
    runs.push({ from: day.date, to: day.date, code: day.code });
  }
  return runs;
}
