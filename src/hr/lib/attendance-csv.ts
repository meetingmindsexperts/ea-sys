/**
 * The attendance grid as a CSV, built from the SAME three functions the screen
 * builds itself from: `employedInMonth` for the rows, `eachDate` for the
 * columns, `effectiveStatusFor` for every cell.
 *
 * That is the whole design, and it is not tidiness. An ordinary working day has
 * no row in the database — the grid derives it, and the precedence that decides
 * between a recorded entry, a public holiday, a weekend and a standing rule
 * lives in exactly one place. A second implementation for the export would be a
 * second answer to "was she at work on the 3rd", and the one that leaves the
 * building is the one payroll acts on. So this file resolves nothing itself.
 *
 * Pure: no `db`, no Node built-ins, so it is unit-testable and the route stays
 * about auth and streaming.
 */

import { toCsvRow } from "@/lib/csv-escape";
import { eachDate, type CalendarDate } from "./hr-date";
import { employedInMonth } from "./attendance-grid";
import { effectiveStatusFor } from "./hr-effective-status";
import { type AttendanceRuleLike } from "./attendance-rules";

export interface AttendanceCsvEmployee {
  id: string;
  empCode: string;
  name: string;
  department: string | null;
  joiningDate: string;
  exitDate: string | null;
}

export interface AttendanceCsvInput {
  employees: readonly AttendanceCsvEmployee[];
  from: CalendarDate;
  to: CalendarDate;
  entries: readonly { employeeId: string; date: string; code: string }[];
  holidays: readonly { date: string; label: string }[];
  rules: readonly AttendanceRuleLike[];
}

export interface AttendanceCsvResult {
  csv: string;
  /** Rows written, for the audit trail. Employees, not cells. */
  rowCount: number;
}

/**
 * One row per person, one column per day, the effective code in each cell.
 *
 * The wide shape is deliberate: it is what the screen shows and what the
 * workbook this replaced showed, so a reader can check the file against the
 * page without translating between two layouts.
 *
 * The `derived` flag is NOT encoded. On screen a dot distinguishes a day a
 * standing rule spoke for from one somebody typed, but marking it here (`WFH*`)
 * would break the first thing anyone does with this file, which is filter a
 * column for a code. The distinction is available on the grid, and the audit
 * trail records who typed what; a payroll figure does not change either way.
 */
export function buildAttendanceCsv(input: AttendanceCsvInput): AttendanceCsvResult {
  const days = eachDate(input.from, input.to);
  const holidays = new Set(input.holidays.map((h) => h.date as CalendarDate));

  // Entries indexed per person, so the resolver is handed the same shape the
  // grid hands it rather than a filtered array per cell.
  const byEmployee = new Map<string, Map<CalendarDate, { code: string }>>();
  for (const e of input.entries) {
    const inner = byEmployee.get(e.employeeId) ?? new Map<CalendarDate, { code: string }>();
    inner.set(e.date as CalendarDate, { code: e.code });
    byEmployee.set(e.employeeId, inner);
  }
  const EMPTY = new Map<CalendarDate, { code: string }>();

  // Leavers are included and then cut to the people employed at some point in
  // the window — the same rule the grid applies, so the file has the same rows
  // as the screen it was exported from.
  const rows = input.employees.filter((e) => employedInMonth(e, input.from, input.to));

  const lines: string[] = [
    toCsvRow(["Employee code", "Name", "Department", ...days]),
  ];
  for (const employee of rows) {
    const entriesByDate = byEmployee.get(employee.id) ?? EMPTY;
    const cells = days.map((date) => {
      const status = effectiveStatusFor(date, {
        employment: {
          joiningDate: employee.joiningDate as CalendarDate,
          exitDate: (employee.exitDate ?? null) as CalendarDate | null,
        },
        entriesByDate,
        holidays,
        rules: input.rules,
        employeeId: employee.id,
      });
      // A day outside employment is blank rather than the sentinel: the person
      // was not there, and printing NOT_EMPLOYED in a payroll column invites
      // somebody to treat it as a leave code.
      return status.code === "NOT_EMPLOYED" ? "" : status.code;
    });
    lines.push(toCsvRow([employee.empCode, employee.name, employee.department ?? "", ...cells]));
  }

  // Trailing newline: some tools drop the last line without it.
  return { csv: lines.join("\n") + "\n", rowCount: rows.length };
}
