/**
 * CI wrapper for scripts/db-local-op.test.sh.
 *
 * The local-database guards are shell scripts, so their branches would
 * otherwise sit outside every gate we run — and a safety script that only
 * executes on a bad day is exactly the kind that rots unnoticed (the same
 * argument as the worker-watchdog wrapper beside this one).
 *
 * The suite runs against a fake `docker` and a fake `prisma`, so no container
 * is needed and no destructive command is ever really issued.
 *
 * The properties worth protecting, each mutation-verified:
 *   - a data-loss flag refuses AND the documented override still works;
 *   - a failed snapshot BLOCKS the operation rather than proceeding without
 *     an undo point;
 *   - a production target is refused before anything is snapshotted;
 *   - restoring snapshots the current state first, so a wrong pick is undoable.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { join } from "path";

describe("local database guards", () => {
  it("passes every case in scripts/db-local-op.test.sh", () => {
    const script = join(process.cwd(), "scripts/db-local-op.test.sh");
    let out = "";
    let failed = false;
    try {
      out = execFileSync("bash", [script], { encoding: "utf8", timeout: 120_000 });
    } catch (err) {
      failed = true;
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(out, out).toContain("FAIL=0");
    expect(failed, out).toBe(false);
  });
});
