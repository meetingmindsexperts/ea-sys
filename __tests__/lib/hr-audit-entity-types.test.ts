/**
 * HR_AUDIT_ENTITY_TYPES — the set the Activity feed's HR boundary is built on.
 *
 * WHY A SOURCE-LEVEL GUARD. The org Activity feed EXCLUDES this set by default
 * and shows it only behind `canViewHr`. If an HR service starts writing audit
 * rows under an entity type that is not in the set, those rows land back in
 * the general feed for every admin, which is precisely the exposure the set
 * closes, recurring silently: no type error, no failing route test, no log
 * line. So the guard reads the HR sources and fails on the first literal that
 * is missing here. Same shape as the migration and tenancy gates: derived from
 * what the code actually does, not from a hand-maintained list.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HR_AUDIT_ENTITY_TYPES, isHrAuditEntityType } from "@/lib/hr-visibility";
import { auditEntityIcon, HR_AUDIT_ENTITY_LABELS } from "@/components/activity/audit-log-display";
import { Activity } from "lucide-react";

const HR_SOURCE_ROOTS = ["src/hr", "src/app/api/hr", "src/app/(dashboard)/hr"];
const HR_WORKER_FILES = ["worker/jobs/hr-year-roll.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const LITERAL = /entityType:\s*"([A-Za-z]+)"/g;

function entityTypeLiterals(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(LITERAL)) {
      const list = found.get(m[1]) ?? [];
      list.push(f);
      found.set(m[1], list);
    }
  }
  return found;
}

describe("HR_AUDIT_ENTITY_TYPES stays in sync with what the HR module writes", () => {
  const hrFiles = [...HR_SOURCE_ROOTS.flatMap((r) => walk(r)), ...HR_WORKER_FILES];
  const written = entityTypeLiterals(hrFiles);

  it("finds the HR audit writers at all (the guard is not passing vacuously)", () => {
    expect(written.size).toBeGreaterThanOrEqual(4);
  });

  it("every entityType the HR module writes is in the set", () => {
    const missing = [...written.entries()]
      .filter(([type]) => !isHrAuditEntityType(type))
      .map(([type, files]) => `${type} (written in ${files.join(", ")})`);
    expect(
      missing,
      `Add these to HR_AUDIT_ENTITY_TYPES in src/lib/hr-visibility.ts, or their rows will show in the general Changes feed for admins with no HR grant`,
    ).toEqual([]);
  });

  it("no core file writes an HR entity type (the exclusion never hides non-HR work)", () => {
    const coreFiles = walk("src").filter(
      (f) => !HR_SOURCE_ROOTS.some((r) => f.startsWith(r)),
    );
    const coreWritten = entityTypeLiterals(coreFiles);
    const leaks = [...coreWritten.entries()]
      .filter(([type]) => isHrAuditEntityType(type))
      .map(([type, files]) => `${type} in ${files.join(", ")}`);
    expect(leaks).toEqual([]);
  });
});

describe("the set is usable by the UI", () => {
  it("has a label and a non-generic icon for every member", () => {
    for (const t of HR_AUDIT_ENTITY_TYPES) {
      expect(HR_AUDIT_ENTITY_LABELS[t], `label for ${t}`).toBeTruthy();
      expect(auditEntityIcon(t), `icon for ${t}`).not.toBe(Activity);
    }
  });

  it("does not claim an events-business type", () => {
    for (const t of ["Registration", "Speaker", "Session", "Contact", "User", "Invoice"]) {
      expect(isHrAuditEntityType(t)).toBe(false);
    }
  });
});
