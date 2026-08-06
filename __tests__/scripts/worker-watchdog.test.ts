/**
 * CI wrapper for scripts/worker-watchdog.test.sh.
 *
 * The watchdog is a shell script, so its 16-case state machine would
 * otherwise live outside every gate we run — and an ops script that only
 * executes on a bad day is exactly the kind that rots unnoticed. This runs
 * the bash suite (against a fake `docker`, so no container is needed) and
 * fails the vitest run if any case regresses.
 *
 * The two properties worth protecting: a deploy blip must never trigger a
 * restart, and a restart loop must be capped rather than churn the box.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { join } from "path";

describe("worker-watchdog.sh state machine", () => {
  it("passes every case in scripts/worker-watchdog.test.sh", () => {
    const script = join(process.cwd(), "scripts/worker-watchdog.test.sh");
    let out = "";
    let failed = false;
    try {
      out = execFileSync("bash", [script], {
        encoding: "utf8",
        timeout: 60_000,
        // Inherit nothing that could make the script talk to real infra;
        // the suite already forces SEND_ALERTS=0 and a fake docker.
        env: { ...process.env, SEND_ALERTS: "0" },
      });
    } catch (err) {
      failed = true;
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(out, out).toContain("FAIL=0");
    expect(failed, out).toBe(false);
  });
});
