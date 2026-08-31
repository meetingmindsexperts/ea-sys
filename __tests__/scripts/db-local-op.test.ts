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
  /**
   * The shell suite sleeps ~4s on purpose (snapshot filenames are stamped per
   * SECOND, so the prune case has to space them out to have a real order), and
   * does a good deal of work besides. On a busy machine that runs past
   * vitest's DEFAULT 10s test timeout and the run dies with "Test timed out in
   * 10000ms" and none of the script's own output — which reads like a flaky
   * assertion and is nothing of the sort.
   *
   * Note the shape of the bug, because it is easy to repeat: there were TWO
   * timeouts on one operation. execFileSync was deliberately given 120s, and
   * that intent was silently overridden by a default nobody set. When two
   * timeouts guard the same call the OUTER one must be the longer, or the
   * inner one's much better error can never surface — so this sits just above
   * the child's, and a genuinely wedged script still fails with its own output
   * attached rather than a bare stopwatch message.
   */
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
  }, 130_000);
});
