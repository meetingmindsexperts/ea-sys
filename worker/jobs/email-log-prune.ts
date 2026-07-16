/**
 * email-log-prune job — retention for sent-email audit bodies.
 *
 * Cadence: 03:45 UTC daily. Every send stores its final rendered HTML on
 * `EmailLog.htmlBody` (July 16, 2026 — "the Activity view shows exactly what
 * was sent"); this job nulls bodies older than the retention window (180
 * days) while keeping the log row itself forever. Batched + per-tick capped;
 * self-healing (a missed run catches up next tick).
 */

import { runEmailLogPruneTick } from "@/lib/email-log-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "email-log-prune";
export const JOB_ID = JOB_IDS.EMAIL_LOG_PRUNE;
export const SCHEDULE = "45 3 * * *"; // 03:45 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runEmailLogPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
