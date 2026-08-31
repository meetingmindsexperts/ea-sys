/**
 * The workbook re-sync, decided without a database.
 *
 * The two guards that matter are refusals: a field a person changed in the app
 * is never overwritten, and a day the app recorded is never removed. Both are
 * silent when broken (the sync simply "works"), so each is pinned here and
 * mutation-verified.
 */
import { describe, it, expect } from "vitest";
import {
  appEditedFields,
  contiguousRuns,
  planEmployeeSync,
  planEntrySync,
  type EmployeeSyncValues,
} from "../../scripts/hr-sync-plan";
import { reconcile, statusFromSheet, type ParsedWorkbook } from "../../scripts/hr-workbook";

const base: EmployeeSyncValues = {
  name: "Tabian",
  department: "Speaker Management",
  jobTitle: "Medical Liaison Executive",
  joiningDate: "2023-09-25",
  exitDate: null,
  status: "ACTIVE",
  carryoverDays: 0,
  openingSickUsed: 0,
  openingCompOff: 0,
};

describe("planEmployeeSync", () => {
  it("patches every field the workbook changed", () => {
    const { patch, conflicts } = planEmployeeSync(
      base,
      { ...base, name: "Tabian Fatherahman Ahmed Hassan", carryoverDays: -10, openingCompOff: 2 },
      new Set(),
    );
    expect(patch).toEqual({ name: "Tabian Fatherahman Ahmed Hassan", carryoverDays: -10, openingCompOff: 2 });
    expect(conflicts).toEqual([]);
  });

  it("produces nothing when the two agree", () => {
    expect(planEmployeeSync(base, { ...base }, new Set())).toEqual({ patch: {}, conflicts: [] });
  });

  /**
   * THE GUARD. Leena's carryover was typed into the app as 15 after the
   * import; the workbook still says 0. The app value is a decision, the
   * workbook's is stale. Overwriting it would silently undo a person's work.
   */
  it("never overwrites a field a person changed in the app; it reports a conflict", () => {
    const app = { ...base, name: "Leena", carryoverDays: 15 };
    const workbook = { ...base, name: "Leena Ala Eddin", carryoverDays: 0 };
    const { patch, conflicts } = planEmployeeSync(app, workbook, new Set(["carryoverDays"]));
    expect(patch).toEqual({ name: "Leena Ala Eddin" });
    expect(conflicts).toEqual([{ field: "carryoverDays", app: 15, workbook: 0 }]);
  });

  /**
   * The sheet carries "Medical Liaison Executive " with a trailing space and the
   * app trims on save. On prod that read as two jobTitle conflicts that nobody
   * could see; whitespace is not a difference and not a decision.
   */
  it("treats a whitespace-only difference as agreement", () => {
    const { patch, conflicts } = planEmployeeSync(
      { ...base, jobTitle: "Medical Liaison Executive" },
      { ...base, jobTitle: "Medical Liaison Executive " },
      new Set(["jobTitle"]),
    );
    expect(patch).toEqual({});
    expect(conflicts).toEqual([]);
  });

  it("does not report a conflict for an app-edited field the workbook agrees with", () => {
    const app = { ...base, carryoverDays: 15 };
    const { patch, conflicts } = planEmployeeSync(app, { ...app }, new Set(["carryoverDays"]));
    expect(patch).toEqual({});
    expect(conflicts).toEqual([]);
  });
});

describe("appEditedFields", () => {
  it("reads the field-diff audit shape", () => {
    const fields = appEditedFields([{ changed: { carryoverDays: { from: 0, to: 15 }, notes: "changed" }, source: "ui" }]);
    expect([...fields]).toEqual(["carryoverDays"]);
  });

  it("reads the original before/after snapshot shape and keeps only the fields that differ", () => {
    const before = { id: "e1", name: "Leena", carryoverDays: 0, status: "ACTIVE", notes: null, annualEntitlementDays: null };
    const after = { ...before, name: "Leena Ala Eddin", carryoverDays: 15, annualEntitlementDays: 30 };
    expect([...appEditedFields([{ before, after }])].sort()).toEqual(["carryoverDays", "name"]);
  });

  /**
   * A sync's own earlier write must not count as a person's decision, or the
   * second workbook could never move a value the first one set.
   */
  it("ignores audit rows a sync wrote", () => {
    expect(appEditedFields([{ changed: { carryoverDays: { from: 0, to: -10 } }, source: "import" }]).size).toBe(0);
  });

  it("does not count a whitespace-only save as an edit", () => {
    const before = { jobTitle: "Medical Liaison Executive ", name: "Tabian" };
    const after = { jobTitle: "Medical Liaison Executive", name: "Tabian Fatherahman" };
    expect([...appEditedFields([{ before, after }])]).toEqual(["name"]);
  });

  it("tolerates rows that are not objects", () => {
    expect(appEditedFields([null, "x", 3, {}]).size).toBe(0);
  });
});

describe("planEntrySync", () => {
  const imp = (date: string, code: string) => ({ date, code, source: "import" });
  const ui = (date: string, code: string) => ({ date, code, source: "ui" });

  it("adds, changes and removes import-owned days to match the workbook", () => {
    const plan = planEntrySync(
      [imp("2026-04-17", "AL"), imp("2026-05-04", "AL"), imp("2026-08-28", "AL")],
      [{ date: "2026-05-04", code: "SL-F" }, { date: "2026-08-31", code: "WFH" }],
    );
    expect(plan.add).toEqual([{ date: "2026-08-31", code: "WFH" }]);
    expect(plan.change).toEqual([{ date: "2026-05-04", from: "AL", to: "SL-F" }]);
    expect(plan.remove).toEqual([{ date: "2026-04-17", code: "AL" }, { date: "2026-08-28", code: "AL" }]);
    expect(plan.appOnly).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  /**
   * THE GUARD. Jinan's 31 August was recorded on the grid before the workbook
   * arrived. A workbook that does not carry it is behind, not authoritative.
   */
  it("never removes or re-codes a day the app recorded", () => {
    const plan = planEntrySync(
      [ui("2026-08-31", "WFH"), ui("2026-09-01", "AL")],
      [{ date: "2026-09-01", code: "SL-F" }],
    );
    expect(plan.remove).toEqual([]);
    expect(plan.change).toEqual([]);
    expect(plan.appOnly).toEqual([{ date: "2026-08-31", code: "WFH" }]);
    expect(plan.conflicts).toEqual([{ date: "2026-09-01", app: "AL", workbook: "SL-F" }]);
  });

  it("is a no-op when the app already holds the workbook's day, whoever recorded it", () => {
    const plan = planEntrySync([ui("2026-08-31", "WFH"), imp("2026-01-05", "AL")], [
      { date: "2026-08-31", code: "WFH" },
      { date: "2026-01-05", code: "AL" },
    ]);
    expect(plan).toEqual({ add: [], change: [], remove: [], appOnly: [], conflicts: [] });
  });
});

describe("contiguousRuns", () => {
  it("folds consecutive same-code days and splits on a gap or a code change", () => {
    const runs = contiguousRuns([
      { date: "2026-03-04", code: "AL" },
      { date: "2026-03-02", code: "AL" },
      { date: "2026-03-03", code: "AL" },
      { date: "2026-03-05", code: "SL-F" },
      { date: "2026-03-09", code: "AL" },
    ]);
    expect(runs).toEqual([
      { from: "2026-03-02", to: "2026-03-04", code: "AL" },
      { from: "2026-03-05", to: "2026-03-05", code: "SL-F" },
      { from: "2026-03-09", to: "2026-03-09", code: "AL" },
    ]);
  });
});

describe("statusFromSheet", () => {
  it("takes the sheet's word when it agrees with the date", () => {
    expect(statusFromSheet("Active", null, "2026-08-31")).toBe("ACTIVE");
    expect(statusFromSheet("Active", "2027-02-15", "2026-08-31")).toBe("ACTIVE");
    expect(statusFromSheet("Resigned", "2026-07-31", "2026-08-31")).toBe("RESIGNED");
    expect(statusFromSheet("terminated", "2026-04-21", "2026-08-31")).toBe("TERMINATED");
  });

  it("lets a past last working day overrule a stale 'Active'", () => {
    expect(statusFromSheet("Active", "2026-07-31", "2026-08-31")).toBe("RESIGNED");
    expect(statusFromSheet(null, "2026-07-31", "2026-08-31")).toBe("RESIGNED");
    expect(statusFromSheet(null, null, "2026-08-31")).toBe("ACTIVE");
  });
});

describe("reconcile", () => {
  function workbook(over: {
    carryoverDays?: number;
    masterEntitlement?: number | null;
    summaryEntitlement?: number;
    entitlementIsFormula?: boolean;
    annualTaken?: number;
    annualBalance?: number;
    entries?: { date: string; code: string }[];
  }): ParsedWorkbook {
    const carryoverDays = over.carryoverDays ?? 0;
    const entries = over.entries ?? [
      { date: "2026-03-02", code: "AL" }, { date: "2026-03-03", code: "AL" }, { date: "2026-03-04", code: "AL" },
      { date: "2026-03-05", code: "AL" }, { date: "2026-03-06", code: "AL" },
    ];
    return {
      file: "fixture.xlsx",
      employees: [{
        empCode: "EMP013", name: "Tabian", department: null, jobTitle: null,
        joiningDate: "2023-09-25", exitDate: null, status: "ACTIVE",
        carryoverDays, openingSickUsed: 0, openingCompOff: 0,
        entitlement: over.masterEntitlement === undefined ? 30 : over.masterEntitlement,
      }],
      skippedEmployees: [],
      entriesByEmp: new Map([["EMP013", entries.map((e) => ({ ...e, category: "ANNUAL" as const, dayWeight: 1 }))]]),
      informative: entries.length,
      derivable: 0,
      unknownCodes: new Map(),
      summary: [{
        empCode: "EMP013", name: "Tabian",
        entitlement: over.summaryEntitlement ?? 30 + carryoverDays,
        entitlementIsFormula: over.entitlementIsFormula ?? true,
        annualTaken: over.annualTaken ?? entries.length,
        annualBalance: over.annualBalance ?? 30 + carryoverDays - entries.length,
        sickFull: 0, odDays: 0, compEarned: 0, compTaken: 0, compBalance: 0,
      }],
    };
  }

  /**
   * THE GATE BUG. Leave Summary D is entitlement PLUS carryover, so reading the
   * entitlement from D and adding our own carried-in figure counted a carryover
   * twice. Every H was 0 in the first workbook, which is why 22 of 23 matched
   * and nobody saw it; the second workbook carried -10 and +3.
   */
  it("does not count a carryover twice", () => {
    const rec = reconcile(workbook({ carryoverDays: -10 }));
    expect(rec.variances).toEqual([]);
    expect(rec.rows[0]).toMatchObject({ ok: true, annualTaken: 5, annualBalance: 15 });
  });

  it("holds the engine to the formula when a summary cell was typed over, and says so", () => {
    const rec = reconcile(workbook({ summaryEntitlement: 0, entitlementIsFormula: false, annualBalance: -5 }));
    expect(rec.rows[0]).toMatchObject({ ok: true, annualBalance: 25 });
    expect(rec.variances).toHaveLength(1);
    expect(rec.variances[0]).toMatchObject({ kind: "workbook-inconsistent", empCode: "EMP013" });
    expect(rec.variances[0].text).toContain("typed as 0 where its formula gives 30");
  });

  it("reports a genuine disagreement as unexpected", () => {
    const rec = reconcile(workbook({ annualTaken: 4, annualBalance: 26 }));
    expect(rec.matched).toBe(0);
    expect(rec.variances[0]).toMatchObject({ kind: "unexpected" });
    expect(rec.variances[0].text).toContain("AL taken 5 vs 4");
  });
});
