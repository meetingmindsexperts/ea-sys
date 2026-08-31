/**
 * One-time import of the UAE attendance workbook, and the gate that makes it
 * trustworthy.
 *
 *   npx tsx scripts/import-hr-excel.ts --file <path>            # dry run, NO database
 *   npx tsx scripts/import-hr-excel.ts --file <path> --org <id> --write
 *
 * THE DRY RUN TOUCHES NO DATABASE AT ALL. It parses the workbook, feeds the
 * entries through the same pure balance engine the application uses, and
 * compares the result against the workbook's own Leave Summary sheet. That is
 * the strongest available check on the engine, and making it offline means it
 * can be run anywhere, by anyone, before anything is written.
 *
 * ONE VARIANCE IS EXPECTED, and it is reported as expected rather than as a
 * failure: the workbook credits EMP002 a comp-off for a Wednesday plus Thursday
 * pair, because its formula asks "was yesterday also OD" rather than "were both
 * days of the same weekend worked". Under the rule we were given (owner,
 * Aug 27 2026) that earns nothing. See docs/HR_MODULE_PLAN.md §3.2.
 */
import { Workbook, cell, excelSerialToDate } from "./hr-xlsx";
import { computeLeaveBalance, type BalanceEntry } from "../src/hr/lib/leave-balance";
import { HR_LEAVE_CODE_SEED } from "../src/hr/lib/hr-seed-data";
import type { LeaveCategory } from "@prisma/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const WRITE = process.argv.includes("--write");

/** code -> { category, weight }, matched case-insensitively (the workbook writes "Hajj"). */
const CODE_MAP = new Map(
  HR_LEAVE_CODE_SEED.map((c) => [
    c.code.toLowerCase(),
    { category: c.countsAs as LeaveCategory, weight: c.dayWeight },
  ]),
);

/** Rows that carry no information: the derived default the module does not store. */
const DERIVABLE = new Set(["P", "OFF", "PH"]);

interface SheetEmployee {
  empCode: string;
  name: string;
  department: string | null;
  jobTitle: string | null;
  joiningDate: string;
  exitDate: string | null;
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
}

interface SummaryRow {
  empCode: string;
  name: string;
  entitlement: number;
  annualTaken: number;
  annualBalance: number;
  sickFull: number;
  odDays: number;
  compEarned: number;
  compTaken: number;
  compBalance: number;
}

function n(value: string | null): number {
  return value === null ? 0 : Number(value);
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("Usage: --file <workbook.xlsx> [--org <organizationId> --write]");
    process.exit(1);
  }
  const wb = new Workbook(file);
  const names = wb.sheetNames();
  const sheet = (label: string) => names.indexOf(label) + 1;

  // ---- Employee Master -----------------------------------------------------
  const employees: SheetEmployee[] = [];
  const skippedEmployees: string[] = [];
  for (const row of wb.rows(sheet("Employee Master")).slice(1)) {
    const empCode = cell(row, "A");
    const name = cell(row, "B");
    const joining = cell(row, "E");
    // EMP024 and EMP025 are placeholder rows: the literal name "0" and no
    // joining date. Creating employees from them is the phantom-row class the
    // module exists to avoid.
    if (!empCode || !name || name === "0" || !joining) {
      if (empCode) skippedEmployees.push(empCode);
      continue;
    }
    const exit = cell(row, "L");
    employees.push({
      empCode,
      name,
      department: cell(row, "C"),
      jobTitle: cell(row, "D"),
      joiningDate: excelSerialToDate(Number(joining)),
      exitDate: exit ? excelSerialToDate(Number(exit)) : null,
      carryoverDays: n(cell(row, "H")),
      openingSickUsed: n(cell(row, "I")),
      openingCompOff: n(cell(row, "J")),
    });
  }

  // ---- Daily Attendance ----------------------------------------------------
  const entriesByEmp = new Map<string, BalanceEntry[]>();
  let informative = 0;
  let derivable = 0;
  const unknownCodes = new Map<string, number>();
  for (const row of wb.rows(sheet("Daily Attendance")).slice(1)) {
    const empCode = cell(row, "C");
    const serial = cell(row, "A");
    const code = cell(row, "F");
    if (!empCode || !serial || !code) continue;
    if (DERIVABLE.has(code)) {
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
    if (!empCode || !name || name === "0") continue;
    summary.push({
      empCode,
      name,
      entitlement: n(cell(row, "D")),
      annualTaken: n(cell(row, "E")),
      annualBalance: n(cell(row, "F")),
      sickFull: n(cell(row, "G")),
      odDays: n(cell(row, "S")),
      compEarned: n(cell(row, "T")),
      compTaken: n(cell(row, "U")),
      compBalance: n(cell(row, "V")),
    });
  }

  console.log(`\nWorkbook: ${file}`);
  console.log(`  employees: ${employees.length} imported, ${skippedEmployees.length} skipped (${skippedEmployees.join(", ") || "none"})`);
  console.log(`  attendance: ${informative} informative rows kept, ${derivable} derivable rows skipped`);
  if (unknownCodes.size > 0) {
    console.log(`  ⚠ unknown codes: ${[...unknownCodes].map(([c, k]) => `${c} x${k}`).join(", ")}`);
  }

  // ---- Reconciliation ------------------------------------------------------
  // The workbook's entitlement is used as-is rather than recomputed, because the
  // gate is testing the BALANCE MATHS, not the clock. Its gate is evaluated
  // against TODAY() and moves; feeding our own would compare two different days.
  console.log("\nReconciliation against the workbook's Leave Summary");
  console.log("=".repeat(88));
  console.log(
    ["emp", "name", "AL taken", "AL bal", "sick", "CO earn", "CO bal"].join("\t"),
  );

  let matched = 0;
  const mismatches: string[] = [];
  for (const s of summary) {
    const e = employees.find((x) => x.empCode === s.empCode);
    if (!e) {
      mismatches.push(`${s.empCode}: in the summary but not in Employee Master`);
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
      leaveYear: 2026,
      asOf: "2026-12-31",
      entries: entriesByEmp.get(s.empCode) ?? [],
    });
    // Entitlement is taken from the sheet so the comparison isolates the maths.
    const ourBalance =
      Math.round((s.entitlement + b.annual.carriedIn - b.annual.taken) * 10) / 10;

    const diffs: string[] = [];
    if (b.annual.taken !== s.annualTaken) diffs.push(`AL taken ${b.annual.taken} vs ${s.annualTaken}`);
    if (ourBalance !== s.annualBalance) diffs.push(`AL balance ${ourBalance} vs ${s.annualBalance}`);
    if (b.sick.full.used !== s.sickFull) diffs.push(`sick full ${b.sick.full.used} vs ${s.sickFull}`);
    if (b.compOff.earned !== s.compEarned) diffs.push(`comp earned ${b.compOff.earned} vs ${s.compEarned}`);
    if (b.compOff.taken !== s.compTaken) diffs.push(`comp taken ${b.compOff.taken} vs ${s.compTaken}`);

    const flag = diffs.length === 0 ? "ok " : "DIFF";
    console.log(
      [flag, s.empCode, s.name.slice(0, 16), b.annual.taken, ourBalance, b.sick.full.used, b.compOff.earned, b.compOff.balance].join("\t"),
    );
    if (diffs.length === 0) matched++;
    else mismatches.push(`${s.empCode} ${s.name}: ${diffs.join("; ")}`);
  }

  console.log("=".repeat(88));
  console.log(`matched ${matched} of ${summary.length}`);
  if (mismatches.length > 0) {
    console.log("\nVariances:");
    for (const m of mismatches) {
      // The single KNOWN one, per docs/HR_MODULE_PLAN.md §3.2.
      const expected = m.startsWith("EMP002") && m.includes("comp earned");
      console.log(`  ${expected ? "EXPECTED" : "UNEXPECTED"}  ${m}`);
    }
    console.log(
      "\nEMP002 is the one expected variance: the workbook credits a comp-off for a",
    );
    console.log(
      "Wed+Thu OD pair, which the weekend rule does not award. Anything else is a bug.",
    );
  }

  const unexpected = mismatches.filter(
    (m) => !(m.startsWith("EMP002") && m.includes("comp earned")),
  );

  if (!WRITE) {
    console.log("\nDry run. Nothing was written. Re-run with --org <id> --write to import.");
    return;
  }

  // THE GATE. The import is accepted only when the engine reproduces the
  // workbook exactly, bar the one known variance. Importing over an unexplained
  // difference would bake it in, and nobody would look again.
  if (unexpected.length > 0) {
    console.error(`\n✋ ${unexpected.length} UNEXPECTED variance(s). Refusing to import.`);
    process.exit(1);
  }
  const organizationId = arg("org");
  if (!organizationId) {
    console.error("\n✋ --write requires --org <organizationId>.");
    process.exit(1);
  }
  await writeToDatabase({ organizationId, employees, entriesByEmp });
}

async function writeToDatabase(input: {
  organizationId: string;
  employees: SheetEmployee[];
  entriesByEmp: Map<string, BalanceEntry[]>;
}) {
  // Imported lazily so the DRY RUN never opens a database connection at all.
  const { db } = await import("../src/lib/db");
  const { runWithTenant } = await import("../src/lib/tenant-context");
  const { ensureLeaveCodes, ensurePublicHolidays } = await import(
    "../src/hr/services/hr-seed-service"
  );
  const { fromCalendarDate } = await import("../src/hr/lib/hr-date");

  await runWithTenant(input.organizationId, async () => {
    // Refuse rather than merge. A second run against a populated org would
    // create duplicate employees under a different id, and the unique key is on
    // (org, empCode) so only SOME of it would fail: a half-import is worse than
    // no import, and worse than an error message.
    const existing = await db.employee.count({
      where: { organizationId: input.organizationId },
    });
    if (existing > 0) {
      console.error(
        `\n✋ That org already has ${existing} employee(s). This import runs once, on an empty org.`,
      );
      process.exit(1);
    }

    await ensureLeaveCodes(input.organizationId);
    await ensurePublicHolidays(input.organizationId);

    const codes = await db.leaveCode.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, countsAs: true, dayWeight: true },
    });
    // Entries are matched back by (category, weight), which is how the parse
    // stored them. Two codes can share a category (SL-F and SL-HD are both
    // SICK_FULL), so the weight is what distinguishes them.
    const codeFor = new Map(
      codes.map((c) => [`${c.countsAs}:${Number(c.dayWeight)}`, c.id]),
    );

    await db.employee.createMany({
      data: input.employees.map((e) => ({
        organizationId: input.organizationId,
        empCode: e.empCode,
        name: e.name,
        department: e.department,
        jobTitle: e.jobTitle,
        joiningDate: fromCalendarDate(e.joiningDate),
        exitDate: e.exitDate ? fromCalendarDate(e.exitDate) : null,
        status: e.exitDate ? ("RESIGNED" as const) : ("ACTIVE" as const),
        carryoverDays: e.carryoverDays,
        openingSickUsed: e.openingSickUsed,
        openingCompOff: e.openingCompOff,
        // The workbook's seeds are true for its own year and no other.
        seedLeaveYear: 2026,
      })),
    });
    const created = await db.employee.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, empCode: true },
    });
    const idFor = new Map(created.map((e) => [e.empCode, e.id]));

    let written = 0;
    const unmatched: string[] = [];
    for (const [empCode, entries] of input.entriesByEmp) {
      const employeeId = idFor.get(empCode);
      // An entry for a person who is not in Employee Master (the placeholder
      // rows) is reported, never silently dropped.
      if (!employeeId) {
        unmatched.push(`${empCode} (${entries.length} rows)`);
        continue;
      }
      const rows = entries
        .map((e) => ({
          organizationId: input.organizationId,
          employeeId,
          date: fromCalendarDate(e.date),
          leaveCodeId: codeFor.get(`${e.category}:${e.dayWeight}`)!,
          source: "import",
        }))
        .filter((r) => r.leaveCodeId);
      if (rows.length !== entries.length) {
        unmatched.push(`${empCode}: ${entries.length - rows.length} rows had no matching leave code`);
      }
      const res = await db.attendanceEntry.createMany({ data: rows, skipDuplicates: true });
      written += res.count;
    }

    console.log(`\n✓ Imported ${created.length} employees and ${written} attendance entries.`);
    if (unmatched.length > 0) {
      console.log(`  ⚠ not imported: ${unmatched.join("; ")}`);
    }
    console.log("  Re-run the dry run against the live data to confirm the balances agree.");
  });
  process.exit(0);
}

main();
