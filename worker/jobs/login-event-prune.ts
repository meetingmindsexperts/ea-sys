/**
 * login-event-prune job — retention for the sign-in history.
 *
 * Cadence: 04:15 UTC daily, deliberately offset from email-log-prune (03:45)
 * so the two retention sweeps don't contend for the same DB window.
 *
 * Deletes `LoginEvent` rows older than 180 days. Batched + per-tick capped;
 * self-healing (a missed run catches up next tick).
 */

import { runLoginEventPruneTick } from "@/lib/login-event-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "login-event-prune";
export const JOB_ID = JOB_IDS.LOGIN_EVENT_PRUNE;
export const SCHEDULE = "15 4 * * *"; // 04:15 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runLoginEventPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
