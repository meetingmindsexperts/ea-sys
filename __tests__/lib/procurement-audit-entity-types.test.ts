/**
 * PROCUREMENT_AUDIT_ENTITY_TYPES: the set the Activity feed's Budget tab is
 * built on, and the set the Changes tab excludes.
 *
 * WHY A SOURCE-LEVEL GUARD. If a procurement service starts writing audit rows
 * under an entity type that is not in the set, those rows land back in the
 * general Changes feed for every admin, raw, which is precisely what the set
 * exists to prevent, recurring silently: no type error, no failing route
 * test, no log line. So the guard reads the module's sources (and the core
 * approvals primitive, whose subjects are all procurement today) and fails on
 * the first literal that is missing here. Same shape as the HR guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EmailLogEntityType } from "@prisma/client";
import { PROCUREMENT_AUDIT_ENTITY_TYPES, isProcurementAuditEntityType } from "@/lib/procurement-visibility";
import { isHrAuditEntityType } from "@/lib/hr-visibility";
import { auditEntityIcon, PROCUREMENT_AUDIT_ENTITY_LABELS } from "@/components/activity/audit-log-display";
import { Activity } from "lucide-react";

const PROCUREMENT_SOURCE_ROOTS = ["src/procurement", "src/app/api/procurement", "src/app/(dashboard)/procurement", "src/lib/approvals"];

// `logContext: { entityType: "OTHER" }` is an EmailLog row, not an AuditLog
// row; the two enums share a key name and nothing else.
const EMAIL_LOG_TYPES: ReadonlySet<string> = new Set(Object.values(EmailLogEntityType));

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
      if (EMAIL_LOG_TYPES.has(m[1])) continue;
      const list = found.get(m[1]) ?? [];
      list.push(f);
      found.set(m[1], list);
    }
  }
  return found;
}

describe("PROCUREMENT_AUDIT_ENTITY_TYPES stays in sync with what the module writes", () => {
  const files = PROCUREMENT_SOURCE_ROOTS.flatMap((r) => walk(r));
  const written = entityTypeLiterals(files);

  it("finds the procurement audit writers at all (the guard is not passing vacuously)", () => {
    expect(written.size).toBeGreaterThanOrEqual(6);
  });

  it("every entityType the module writes is in the set", () => {
    const missing = [...written.entries()]
      .filter(([type]) => !isProcurementAuditEntityType(type))
      .map(([type, files]) => `${type} (written in ${files.join(", ")})`);
    expect(
      missing,
      "Add these to PROCUREMENT_AUDIT_ENTITY_TYPES in src/lib/procurement-visibility.ts, or their rows will show in the general Changes feed, raw",
    ).toEqual([]);
  });

  it("every member of the set is actually written somewhere (no dead entry hiding a real type behind a label)", () => {
    const unwritten = PROCUREMENT_AUDIT_ENTITY_TYPES.filter((t) => !written.has(t));
    expect(unwritten).toEqual([]);
  });

  it("no core file outside the roots writes a procurement entity type (the exclusion never hides non-budget work)", () => {
    const coreFiles = walk("src").filter((f) => !PROCUREMENT_SOURCE_ROOTS.some((r) => f.startsWith(r)));
    const coreWritten = entityTypeLiterals(coreFiles);
    const leaks = [...coreWritten.entries()]
      .filter(([type]) => isProcurementAuditEntityType(type))
      .map(([type, files]) => `${type} in ${files.join(", ")}`);
    expect(leaks).toEqual([]);
  });

  it("the two module sets never overlap (a row belongs to one tab)", () => {
    for (const t of PROCUREMENT_AUDIT_ENTITY_TYPES) expect(isHrAuditEntityType(t), t).toBe(false);
  });
});

describe("the set is usable by the UI", () => {
  it("has a label and a non-generic icon for every member", () => {
    for (const t of PROCUREMENT_AUDIT_ENTITY_TYPES) {
      expect(PROCUREMENT_AUDIT_ENTITY_LABELS[t], `label for ${t}`).toBeTruthy();
      expect(auditEntityIcon(t), `icon for ${t}`).not.toBe(Activity);
    }
  });

  it("does not claim an events-business type", () => {
    for (const t of ["Registration", "Speaker", "Session", "Contact", "User", "Invoice", "Employee"]) {
      expect(isProcurementAuditEntityType(t)).toBe(false);
    }
  });
});
