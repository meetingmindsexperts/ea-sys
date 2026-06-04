/**
 * webinar-attendance job — polls Zoom for participant + engagement
 * reports (polls + Q&A piggybacked on same tick). Cadence: every 10
 * minutes (matches the legacy crontab line).
 */

import { runWebinarAttendanceTick } from "@/lib/webinar-attendance-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "webinar-attendance";
export const JOB_ID = JOB_IDS.WEBINAR_ATTENDANCE;
export const SCHEDULE = "*/10 * * * *"; // every 10 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runWebinarAttendanceTick();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
