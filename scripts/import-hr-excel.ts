/**
 * The UAE attendance workbook: its one-time import, its re-sync, and the gate
 * that makes both trustworthy.
 *
 *   npx tsx scripts/import-hr-excel.ts --file <path>                          # gate only, NO database
 *   npx tsx scripts/import-hr-excel.ts --file <path> --org <id> --write       # first import, empty org
 *   npx tsx scripts/import-hr-excel.ts --file <path> --org <id> --sync        # diff against the org, write nothing
 *   npx tsx scripts/import-hr-excel.ts --file <path> --org <id> --sync --actor <email> --write
 *
 * THE GATE TOUCHES NO DATABASE AT ALL. It parses the workbook, feeds the
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
 *
 * A SYNC IS NOT A SECOND IMPORT. The workbook keeps being re-sent with more
 * data while people record in the app, so the two diverge both ways. The sync
 * applies what changed in the workbook and REFUSES to touch anything a person
 * changed in the app since the import (a field with an audit row, a day whose
 * `source` is not "import"), reporting each such conflict instead. It writes
 * through the same services the screens use, so every change is validated the
 * same way and lands in the audit trail. See scripts/hr-sync-plan.ts.
 */
import { parseHrWorkbook, reconcile, WORKBOOK_LEAVE_YEAR, type ParsedWorkbook, type Reconciliation } from "./hr-workbook";
import {
  appEditedFields,
  contiguousRuns,
  planEmployeeSync,
  planEntrySync,
  type EmployeeSyncValues,
} from "./hr-sync-plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const WRITE = process.argv.includes("--write");
const SYNC = process.argv.includes("--sync");

function printReconciliation(rec: Reconciliation) {
  console.log("\nReconciliation against the workbook's Leave Summary");
  console.log("=".repeat(88));
  console.log(["emp", "name", "AL taken", "AL bal", "sick", "CO earn", "CO bal"].join("\t"));
  for (const r of rec.rows) {
    console.log(
      [r.ok ? "ok " : "DIFF", r.empCode, r.name.slice(0, 16), r.annualTaken, r.annualBalance, r.sickFull, r.compEarned, r.compBalance].join("\t"),
    );
  }
  console.log("=".repeat(88));
  console.log(`matched ${rec.matched} of ${rec.total}`);
  if (rec.variances.length > 0) {
    console.log("\nVariances:");
    for (const v of rec.variances) {
      const label = v.kind === "expected" ? "EXPECTED" : v.kind === "workbook-inconsistent" ? "WORKBOOK" : "UNEXPECTED";
      console.log(`  ${label.padEnd(10)} ${v.text}`);
    }
    console.log("\nEMP002 is the one expected variance: the workbook credits a comp-off for a");
    console.log("Wed+Thu OD pair, which the weekend rule does not award. WORKBOOK means the");
    console.log("sheet contradicts itself and the app was left alone. Anything UNEXPECTED is a bug.");
  }
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("Usage: --file <workbook.xlsx> [--org <organizationId> [--sync [--actor <email>]] --write]");
    process.exit(1);
  }
  const parsed = parseHrWorkbook(file);

  console.log(`\nWorkbook: ${file}`);
  console.log(`  employees: ${parsed.employees.length} read, ${parsed.skippedEmployees.length} placeholder rows skipped (${parsed.skippedEmployees.join(", ") || "none"})`);
  console.log(`  attendance: ${parsed.informative} informative rows kept, ${parsed.derivable} derivable rows skipped`);
  if (parsed.unknownCodes.size > 0) {
    console.log(`  ⚠ unknown codes: ${[...parsed.unknownCodes].map(([c, k]) => `${c} x${k}`).join(", ")}`);
  }

  const rec = reconcile(parsed);
  printReconciliation(rec);
  const unexpected = rec.variances.filter((v) => v.kind === "unexpected");

  if (SYNC) {
    await syncWithDatabase({ parsed, unexpected: unexpected.length });
    return;
  }

  if (!WRITE) {
    console.log("\nDry run. Nothing was written. Re-run with --org <id> --write to import, or --org <id> --sync to diff against an org.");
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
  await writeToDatabase({ organizationId, parsed });
}

async function writeToDatabase(input: { organizationId: string; parsed: ParsedWorkbook }) {
  // Imported lazily so the gate never opens a database connection at all.
  const { db } = await import("../src/lib/db");
  const { runWithTenant } = await import("../src/lib/tenant-context");
  const { ensureLeaveCodes, ensurePublicHolidays } = await import("../src/hr/services/hr-seed-service");
  const { fromCalendarDate } = await import("../src/hr/lib/hr-date");
  const { employees, entriesByEmp } = input.parsed;

  await runWithTenant(input.organizationId, async () => {
    // Refuse rather than merge. A second run against a populated org would
    // create duplicate employees under a different id, and the unique key is on
    // (org, empCode) so only SOME of it would fail: a half-import is worse than
    // no import, and worse than an error message. A later workbook is a --sync.
    const existing = await db.employee.count({ where: { organizationId: input.organizationId } });
    if (existing > 0) {
      console.error(`\n✋ That org already has ${existing} employee(s). The import runs once, on an empty org; use --sync for a later workbook.`);
      process.exit(1);
    }

    await ensureLeaveCodes(input.organizationId);
    await ensurePublicHolidays(input.organizationId);

    const codes = await db.leaveCode.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, code: true },
    });
    const codeFor = new Map(codes.map((c) => [c.code, c.id]));

    await db.employee.createMany({
      data: employees.map((e) => ({
        organizationId: input.organizationId,
        empCode: e.empCode,
        name: e.name,
        department: e.department,
        jobTitle: e.jobTitle,
        joiningDate: fromCalendarDate(e.joiningDate),
        exitDate: e.exitDate ? fromCalendarDate(e.exitDate) : null,
        status: e.status,
        carryoverDays: e.carryoverDays,
        openingSickUsed: e.openingSickUsed,
        openingCompOff: e.openingCompOff,
        // The workbook's seeds are true for its own year and no other.
        seedLeaveYear: WORKBOOK_LEAVE_YEAR,
      })),
    });
    const created = await db.employee.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, empCode: true },
    });
    const idFor = new Map(created.map((e) => [e.empCode, e.id]));

    let written = 0;
    const unmatched: string[] = [];
    for (const [empCode, entries] of entriesByEmp) {
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
          leaveCodeId: codeFor.get(e.code)!,
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
    console.log("  Re-run the gate against the live data to confirm the balances agree.");
  });
  process.exit(0);
}

/**
 * Diff the workbook against an org, and with --write apply the part of the
 * difference that nobody in the app has overruled.
 */
async function syncWithDatabase(input: { parsed: ParsedWorkbook; unexpected: number }) {
  const organizationId = arg("org");
  if (!organizationId) {
    console.error("\n✋ --sync requires --org <organizationId>.");
    process.exit(1);
  }
  const { db } = await import("../src/lib/db");
  const { runWithTenant } = await import("../src/lib/tenant-context");
  const { toCalendarDate } = await import("../src/hr/lib/hr-date");
  const { EMPLOYEE_SELECT, toEmployeeView, createEmployee, updateEmployee } = await import("../src/hr/services/employee-service");
  const { setAttendance, clearAttendance } = await import("../src/hr/services/attendance-service");
  const { parsed } = input;

  await runWithTenant(organizationId, async () => {
    const rows = await db.employee.findMany({
      where: { organizationId },
      select: { ...EMPLOYEE_SELECT, createdAt: true },
      orderBy: { empCode: "asc" },
    });
    const byCode = new Map(rows.map((r) => [r.empCode, r]));
    const ids = rows.map((r) => r.id);

    const [audits, entries] = await Promise.all([
      db.auditLog.findMany({
        where: { entityType: "Employee", action: "UPDATE", entityId: { in: ids } },
        select: { entityId: true, changes: true, createdAt: true },
      }),
      db.attendanceEntry.findMany({
        where: { organizationId, employeeId: { in: ids } },
        select: { employeeId: true, date: true, source: true, leaveCode: { select: { code: true } } },
      }),
    ]);
    const auditsFor = (employeeId: string, since: Date) =>
      audits.filter((a) => a.entityId === employeeId && a.createdAt > since).map((a) => a.changes);
    const entriesFor = (employeeId: string) =>
      entries
        .filter((e) => e.employeeId === employeeId)
        .map((e) => ({ date: toCalendarDate(e.date), code: e.leaveCode.code, source: e.source }));

    console.log(`\nSync against org ${organizationId} (${WRITE ? "WRITE" : "dry run"})`);
    console.log("=".repeat(88));

    type Work = {
      empCode: string;
      name: string;
      employeeId: string | null;
      create: (typeof parsed.employees)[number] | null;
      patch: Partial<EmployeeSyncValues>;
      conflicts: ReturnType<typeof planEmployeeSync>["conflicts"];
      plan: ReturnType<typeof planEntrySync>;
    };
    const work: Work[] = [];
    const totals = { fields: 0, conflicts: 0, creates: 0, add: 0, change: 0, remove: 0, appOnly: 0, dayConflicts: 0 };

    for (const w of parsed.employees) {
      const row = byCode.get(w.empCode);
      const workbookDays = (parsed.entriesByEmp.get(w.empCode) ?? []).map((e) => ({ date: e.date, code: e.code }));
      if (!row) {
        const plan = planEntrySync([], workbookDays);
        work.push({ empCode: w.empCode, name: w.name, employeeId: null, create: w, patch: {}, conflicts: [], plan });
        totals.creates++;
        totals.add += plan.add.length;
        console.log(`  ${w.empCode} ${w.name}: NEW employee, ${plan.add.length} day(s) to record`);
        continue;
      }
      const view = toEmployeeView(row);
      const app: EmployeeSyncValues = {
        name: view.name, department: view.department, jobTitle: view.jobTitle,
        joiningDate: view.joiningDate, exitDate: view.exitDate, status: view.status,
        carryoverDays: view.carryoverDays, openingSickUsed: view.openingSickUsed, openingCompOff: view.openingCompOff,
      };
      const edited = appEditedFields(auditsFor(row.id, row.createdAt));
      const { patch, conflicts } = planEmployeeSync(app, w, edited);
      const plan = planEntrySync(entriesFor(row.id), workbookDays);
      work.push({ empCode: w.empCode, name: w.name, employeeId: row.id, create: null, patch, conflicts, plan });

      const lines: string[] = [];
      for (const [field, value] of Object.entries(patch)) lines.push(`${field} ${String(app[field as keyof EmployeeSyncValues])} -> ${String(value)}`);
      for (const c of conflicts) lines.push(`CONFLICT ${c.field}: app=${String(c.app)} workbook=${String(c.workbook)} (changed in the app since the import; not touched)`);
      for (const d of plan.add) lines.push(`add ${d.date} ${d.code}`);
      for (const d of plan.change) lines.push(`change ${d.date} ${d.from} -> ${d.to}`);
      for (const d of plan.remove) lines.push(`remove ${d.date} ${d.code}`);
      for (const d of plan.appOnly) lines.push(`app-only ${d.date} ${d.code} (recorded in the app, not in the workbook; kept)`);
      for (const d of plan.conflicts) lines.push(`CONFLICT ${d.date}: app=${d.app} workbook=${d.workbook} (recorded in the app; not touched)`);
      totals.fields += Object.keys(patch).length;
      totals.conflicts += conflicts.length;
      totals.add += plan.add.length;
      totals.change += plan.change.length;
      totals.remove += plan.remove.length;
      totals.appOnly += plan.appOnly.length;
      totals.dayConflicts += plan.conflicts.length;
      if (lines.length > 0) console.log(`  ${w.empCode} ${w.name}\n    ${lines.join("\n    ")}`);
    }
    const workbookCodes = new Set(parsed.employees.map((e) => e.empCode));
    for (const r of rows) {
      if (!workbookCodes.has(r.empCode)) console.log(`  ${r.empCode} ${r.name}: in the app, not in the workbook (kept)`);
    }

    console.log("=".repeat(88));
    console.log(
      `${totals.creates} new employee(s), ${totals.fields} field change(s), ${totals.conflicts} field conflict(s); ` +
        `days: ${totals.add} to add, ${totals.change} to change, ${totals.remove} to remove, ${totals.appOnly} app-only kept, ${totals.dayConflicts} conflict(s).`,
    );
    if (totals.conflicts + totals.dayConflicts > 0) {
      console.log("Conflicts are decisions made in the app after the import. The sync never overrides them; change them on the employee's page if the workbook is right.");
    }

    if (!WRITE) {
      console.log("\nDry run. Nothing was written. Re-run with --actor <email> --write to apply.");
      return;
    }
    if (input.unexpected > 0) {
      console.error(`\n✋ ${input.unexpected} UNEXPECTED variance(s) in the gate. Refusing to sync until the engine reproduces the workbook.`);
      process.exit(1);
    }
    const actorEmail = arg("actor")?.trim().toLowerCase();
    if (!actorEmail) {
      console.error("\n✋ --write requires --actor <email>: the person the audit rows are attributed to.");
      process.exit(1);
    }
    const actor = await db.user.findFirst({ where: { email: actorEmail, organizationId }, select: { id: true } });
    if (!actor) {
      console.error(`\n✋ No user ${actorEmail} in that org.`);
      process.exit(1);
    }

    const problems: string[] = [];
    const applied = { employees: 0, days: 0 };
    for (const item of work) {
      let employeeId = item.employeeId;
      if (item.create) {
        const res = await createEmployee({
          organizationId, actorUserId: actor.id, source: "import",
          empCode: item.create.empCode, name: item.create.name,
          department: item.create.department, jobTitle: item.create.jobTitle,
          joiningDate: item.create.joiningDate, exitDate: item.create.exitDate, status: item.create.status,
          carryoverDays: item.create.carryoverDays, openingSickUsed: item.create.openingSickUsed,
          openingCompOff: item.create.openingCompOff, seedLeaveYear: WORKBOOK_LEAVE_YEAR,
        });
        if (!res.ok) {
          problems.push(`${item.empCode}: create refused, ${res.code}: ${res.message}`);
          continue;
        }
        employeeId = res.employee.id;
        applied.employees++;
      } else if (Object.keys(item.patch).length > 0) {
        const res = await updateEmployee({
          organizationId, actorUserId: actor.id, employeeId: employeeId!, source: "import",
          patch: item.patch as Parameters<typeof updateEmployee>[0]["patch"],
        });
        if (res.ok) applied.employees++;
        else problems.push(`${item.empCode}: update refused, ${res.code}: ${res.message}`);
      }
      if (!employeeId) continue;

      for (const run of contiguousRuns([...item.plan.add, ...item.plan.change.map((c) => ({ date: c.date, code: c.to }))])) {
        const res = await setAttendance({
          organizationId, actorUserId: actor.id, source: "import", employeeId,
          from: run.from, to: run.to, code: run.code, includeNonWorkingDays: true,
        });
        if (!res.ok) {
          problems.push(`${item.empCode} ${run.from}..${run.to} ${run.code}: ${res.code}: ${res.message}`);
          continue;
        }
        applied.days += res.result.written;
        if (res.result.skipped.length > 0) problems.push(`${item.empCode}: ${res.result.skipped.length} day(s) outside employment skipped (${res.result.skipped.join(", ")})`);
      }
      for (const run of contiguousRuns(item.plan.remove)) {
        const res = await clearAttendance({ organizationId, actorUserId: actor.id, employeeId, from: run.from, to: run.to });
        if (!res.ok) {
          problems.push(`${item.empCode} clear ${run.from}..${run.to}: ${res.code}: ${res.message}`);
          continue;
        }
        applied.days += res.result.removed;
      }
    }

    console.log(`\n✓ Applied: ${applied.employees} employee record(s), ${applied.days} day(s) written or removed.`);
    if (problems.length > 0) {
      console.log(`  ⚠ ${problems.length} not applied:\n    ${problems.join("\n    ")}`);
    }
    console.log("  Re-run --sync to confirm the remaining difference is only the conflicts listed above.");
  });
  process.exit(0);
}

main();
