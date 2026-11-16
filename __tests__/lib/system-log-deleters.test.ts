/**
 * Who may delete SystemLog rows (Nov 16, 2026). The 30-day system-log-prune job
 * ran every day and the monthly log-archive job only reached months older than
 * the previous one, so every row was deleted before it could be archived: no
 * archive file exists after August 2026. The prune was retired; the owner's
 * rule is archive, never delete logs.
 *
 * Two places delete, and a third fails this test until someone decides it may:
 *   src/lib/log-archive.ts   after writing the month to logs/archive/ (copied
 *                            nightly to the DR bucket by the box crontab)
 *   src/app/api/logs/route.ts  "Clear Logs" on /logs, the operator's own press
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ALLOWED = ["src/lib/log-archive.ts", "src/app/api/logs/route.ts"];
// Prisma calls and raw SQL, any case (review of d1ce3eca: TRUNCATE, lower-case SQL and a schema
// prefix slipped past the first version).
const DELETES = /systemLog\s*\.\s*(deleteMany|delete)\b|(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+(public\.)?"?SystemLog\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".terraform") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|sql|sh)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("SystemLog deleters", () => {
  it("only the archive job and the operator's Clear Logs delete log rows", () => {
    const deleters = ["src", "worker", "scripts", "infra", "prisma"].flatMap(sourceFiles).filter((f) => DELETES.test(readFileSync(f, "utf8")));
    expect(deleters.sort()).toEqual([...ALLOWED].sort());
  });

  it("the pattern catches the forms that slipped past it once", () => {
    for (const code of [
      "db.systemLog.deleteMany({})",
      'await tx.$executeRaw`delete from public."SystemLog" where 1=1`',
      'TRUNCATE TABLE "SystemLog"',
      "truncate systemlog",
    ]) {
      expect(DELETES.test(code), code).toBe(true);
    }
    expect(DELETES.test("db.systemLog.findMany({})")).toBe(false);
  });

  it("the retired prune job is not scheduled again", () => {
    expect(readFileSync("worker/index.ts", "utf8")).not.toMatch(/system-log-prune|systemLogPrune/);
    expect(readFileSync("src/lib/worker-jobs.ts", "utf8")).not.toMatch(/system-log-prune/);
  });
});
