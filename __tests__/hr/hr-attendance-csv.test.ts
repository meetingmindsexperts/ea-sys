/**
 * The exported grid must be the grid on screen.
 *
 * An ordinary working day has no row in the database, so every cell in this
 * file is DERIVED, and the precedence that derives it (explicit entry, then a
 * calendar-day rule, then holiday, then weekend, then a working-day rule, then
 * P) lives in one place. These tests exist to pin that the export asks that
 * one place rather than growing a second answer: the file leaves the building
 * and payroll acts on it, so a divergence here is a wrong figure nobody can
 * see on screen.
 */

import { describe, expect, it } from "vitest";
import { buildAttendanceCsv } from "@/hr/lib/attendance-csv";
import { effectiveStatusFor } from "@/hr/lib/hr-effective-status";
import type { CalendarDate } from "@/hr/lib/hr-date";

const ANA = {
  id: "emp_ana",
  empCode: "EMP001",
  name: "Ana Silva",
  department: "Ops",
  joiningDate: "2020-01-01",
  exitDate: null,
};

// 2026-09-01 is a Tuesday; the 5th and 6th are Saturday and Sunday.
const WEEK = { from: "2026-09-01" as CalendarDate, to: "2026-09-07" as CalendarDate };

const base = {
  employees: [ANA],
  ...WEEK,
  entries: [],
  holidays: [],
  rules: [],
};

const rows = (csv: string) => csv.trimEnd().split("\n");
const cells = (line: string) => line.split(",");

describe("buildAttendanceCsv", () => {
  it("puts the days across the top and the person down the side", () => {
    const { csv, rowCount } = buildAttendanceCsv(base);
    const [header, ana] = rows(csv);
    expect(cells(header)).toEqual([
      "Employee code", "Name", "Department",
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
      "2026-09-05", "2026-09-06", "2026-09-07",
    ]);
    expect(cells(ana).slice(0, 3)).toEqual(["EMP001", "Ana Silva", "Ops"]);
    // Rows are people, not cells: the audit records how many colleagues left
    // the building, which is the number that matters for a PII export.
    expect(rowCount).toBe(1);
  });

  it("derives the weekend rather than leaving it blank", () => {
    const { csv } = buildAttendanceCsv(base);
    const c = cells(rows(csv)[1]).slice(3);
    expect(c).toEqual(["P", "P", "P", "P", "OFF", "OFF", "P"]);
  });

  it("every cell equals what effectiveStatusFor answers", () => {
    // The guard that matters. If the builder ever resolves anything itself,
    // this fails even when the shape still looks right.
    const input = {
      ...base,
      entries: [{ employeeId: ANA.id, date: "2026-09-02", code: "AL" }],
      holidays: [{ date: "2026-09-03", label: "Test Day" }],
      rules: [
        {
          id: "rule_wfh",
          scope: "ORG" as const,
          employeeId: null,
          code: "WFH",
          category: "WORK" as const,
          startDate: "2026-09-04" as CalendarDate,
          endDate: "2026-09-07" as CalendarDate,
        },
      ],
    };
    const { csv } = buildAttendanceCsv(input);
    const got = cells(rows(csv)[1]).slice(3);

    const entriesByDate = new Map([["2026-09-02" as CalendarDate, { code: "AL" }]]);
    const expected = [
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
      "2026-09-05", "2026-09-06", "2026-09-07",
    ].map(
      (d) =>
        effectiveStatusFor(d as CalendarDate, {
          employment: { joiningDate: ANA.joiningDate as CalendarDate, exitDate: null },
          entriesByDate,
          holidays: new Set(["2026-09-03" as CalendarDate]),
          rules: input.rules,
          employeeId: ANA.id,
        }).code,
    );
    expect(got).toEqual(expected);
    // Sanity that the fixture is actually exercising the precedence rather
    // than agreeing on seven identical Ps.
    expect(expected).toContain("AL");
    expect(expected).toContain("PH");
    expect(expected).toContain("WFH");
    expect(expected).toContain("OFF");
  });

  it("blanks days outside employment instead of printing the sentinel", () => {
    // NOT_EMPLOYED in a payroll column invites somebody to read it as a code.
    const { csv } = buildAttendanceCsv({
      ...base,
      employees: [{ ...ANA, joiningDate: "2026-09-04" }],
    });
    const c = cells(rows(csv)[1]).slice(3);
    expect(c.slice(0, 3)).toEqual(["", "", ""]);
    expect(c[3]).toBe("P");
    expect(csv).not.toContain("NOT_EMPLOYED");
  });

  it("keeps a leaver who was employed for part of the window", () => {
    const { csv, rowCount } = buildAttendanceCsv({
      ...base,
      employees: [{ ...ANA, exitDate: "2026-09-03" }],
    });
    expect(rowCount).toBe(1);
    const c = cells(rows(csv)[1]).slice(3);
    expect(c[2]).toBe("P");
    expect(c[3]).toBe("");
  });

  it("drops somebody who was not employed at any point in the window", () => {
    const { csv, rowCount } = buildAttendanceCsv({
      ...base,
      employees: [{ ...ANA, joiningDate: "2027-01-01" }],
    });
    expect(rowCount).toBe(0);
    expect(rows(csv)).toHaveLength(1); // header only
  });

  it("escapes a name that would otherwise be read as a formula", () => {
    // A person's name is attacker-adjacent free text and this file is opened
    // in Excel by definition.
    const { csv } = buildAttendanceCsv({
      ...base,
      employees: [{ ...ANA, name: "=cmd|'/c calc'!A1", department: "Ops, Dubai" }],
    });
    expect(csv).toContain("'=cmd");
    expect(csv).toContain('"Ops, Dubai"');
  });

  it("resolves each person against their own entries", () => {
    // One shared map would put Ana's annual leave on Ben's row.
    const BEN = { ...ANA, id: "emp_ben", empCode: "EMP002", name: "Ben Ito" };
    const { csv } = buildAttendanceCsv({
      ...base,
      employees: [ANA, BEN],
      entries: [{ employeeId: ANA.id, date: "2026-09-01", code: "AL" }],
    });
    const [, ana, ben] = rows(csv);
    expect(cells(ana)[3]).toBe("AL");
    expect(cells(ben)[3]).toBe("P");
  });

  it("ends with a newline so the last row is not dropped", () => {
    expect(buildAttendanceCsv(base).csv.endsWith("\n")).toBe(true);
  });
});
