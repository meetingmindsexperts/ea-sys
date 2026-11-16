/**
 * Role's old enum column is never read or written by this code (Nov 16, 2026;
 * docs/ORG_FIELDS_PLAN.md step 1b).
 *
 * The Prisma field `roleLegacy` is the old "role" column, kept in step by the
 * database trigger `person_role_key_sync` for the PREVIOUS image only during a
 * deploy or a rollback. A database built by `prisma db push` has no trigger, so
 * code that reads it would see stale or empty values there, and code that
 * writes it would fight the trigger. The shared client omits it from every
 * read (src/lib/db.ts); this test keeps every other file off it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const ALLOWED = new Set(["src/lib/db.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "generated") return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("roleLegacy", () => {
  it("is named by no application, worker or script file except the client that omits it", () => {
    const offenders = ["src", "worker", "scripts"]
      .flatMap((dir) => files(join(ROOT, dir)))
      .map((path) => relative(ROOT, path))
      .filter((path) => !ALLOWED.has(path) && readFileSync(join(ROOT, path), "utf8").includes("roleLegacy"));
    expect(offenders).toEqual([]);
  });

  it("is omitted from every read on all four records", () => {
    const source = readFileSync(join(ROOT, "src/lib/db.ts"), "utf8");
    for (const model of ["attendee", "speaker", "contact", "accountProfile"]) {
      expect(source).toContain(`${model}: { roleLegacy: true }`);
    }
  });
});
