/**
 * daily-digest job — the once-a-day infrastructure health email.
 *
 * Cadence: 05:30 UTC = 09:30 Dubai, so it lands as the operator starts the
 * day. Deliberately AFTER the nightly retention sweeps (email-log-prune
 * 03:45, login-event-prune 04:15, system-log-prune 04:45) so the numbers it
 * reports are the post-sweep steady state rather than a mid-prune snapshot.
 *
 * Unlike the alarm + error-alert paths, this one sends whether or not
 * anything happened — silence from it is itself the signal. See
 * src/lib/daily-digest-worker.ts for the verdict model.
 */

import { runDailyDigestTick } from "@/lib/daily-digest-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "daily-digest";
export const JOB_ID = JOB_IDS.DAILY_DIGEST;
export const SCHEDULE = "30 5 * * *"; // 05:30 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runDailyDigestTick();
    } catch (err) {
      // Logged at error on purpose: a digest that silently stops arriving
      // recreates exactly the ambiguity this job exists to remove, so the
      // failure itself pages through the admin-alert forwarding hook.
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
