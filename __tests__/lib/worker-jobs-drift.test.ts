/**
 * Drift guard: the EXPECTED_JOBS roster (shown on the Infra / Ops "Cron / Jobs"
 * card) must match the actual worker job files. Adding/removing a job in
 * worker/jobs/*.ts without updating src/lib/worker-jobs.ts fails here — so a
 * new cron can't silently go unmonitored.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { EXPECTED_JOB_NAMES } from "@/lib/worker-jobs";

function workerJobNames(): Set<string> {
  const dir = join(process.cwd(), "worker/jobs");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    // Only files that actually schedule a job export both JOB_NAME + SCHEDULE.
    if (!/export const SCHEDULE\s*=/.test(src)) continue;
    const m = src.match(/export const JOB_NAME\s*=\s*"([^"]+)"/);
    if (m) names.add(m[1]);
  }
  return names;
}

describe("worker jobs roster (EXPECTED_JOBS) has no drift", () => {
  it("matches every scheduled worker/jobs/*.ts JOB_NAME exactly", () => {
    const actual = workerJobNames();
    expect(actual.size).toBeGreaterThan(0);
    // Every scheduled worker job is listed in the roster…
    for (const name of actual) {
      expect(EXPECTED_JOB_NAMES.has(name), `worker job "${name}" missing from EXPECTED_JOBS`).toBe(true);
    }
    // …and the roster lists no phantom jobs.
    for (const name of EXPECTED_JOB_NAMES) {
      expect(actual.has(name), `EXPECTED_JOBS lists "${name}" which is not a scheduled worker job`).toBe(true);
    }
  });
});
