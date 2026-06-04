/**
 * scheduled-emails job — wraps `runScheduledEmailsTick` in an advisory
 * lock + a top-level try/catch so a tick failure can't crash the
 * scheduler (which would skip ALL future ticks for ALL jobs).
 *
 * Cadence: every 1 minute (matches the legacy crontab line).
 */

import { runScheduledEmailsTick } from "@/lib/scheduled-emails-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "scheduled-emails";
export const JOB_ID = JOB_IDS.SCHEDULED_EMAILS;
export const SCHEDULE = "* * * * *"; // every minute

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runScheduledEmailsTick();
    } catch (err) {
      // Never re-throw — would propagate to node-cron's task handler
      // and could crash the scheduler. The underlying ScheduledEmail
      // state machine handles its own row-level retries via the
      // FAILED status + operator retry button.
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
