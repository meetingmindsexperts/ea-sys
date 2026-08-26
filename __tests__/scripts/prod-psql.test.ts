/**
 * CI wrapper for scripts/prod-psql.test.sh.
 *
 * This guard set read-only with PGOPTIONS and therefore did nothing at all from
 * July 30 to Aug 26 2026: DIRECT_URL points at a Supavisor pooler, which does
 * not forward libpq startup options. Every session that printed "READ-ONLY" was
 * read-write, and nothing anywhere said so.
 *
 * The properties worth protecting:
 *   - PGOPTIONS never comes back, and the read-only SET is still there;
 *   - the script VERIFIES the guard took effect and refuses otherwise, rather
 *     than announcing a protection it does not have;
 *   - a connection failure is reported as a connection failure, not as a guard
 *     failure that would send you to fix working code.
 *
 * Runs against a fake `psql`, so no credential and no network are involved.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { join } from "path";

describe("the production read-only guard", () => {
  it("passes every case in scripts/prod-psql.test.sh", () => {
    const script = join(process.cwd(), "scripts/prod-psql.test.sh");
    let out = "";
    let failed = false;
    try {
      out = execFileSync("bash", [script], { encoding: "utf8", timeout: 60_000 });
    } catch (err) {
      failed = true;
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(out, out).toContain("FAIL=0");
    expect(failed, out).toBe(false);
  });
});
