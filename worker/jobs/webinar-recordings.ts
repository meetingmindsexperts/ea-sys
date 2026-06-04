/**
 * webinar-recordings job — polls Zoom for recordings on webinar-type
 * ZoomMeetings whose session ended in the candidate window. Cadence:
 * every 5 minutes (matches the legacy crontab line).
 */

import { runWebinarRecordingsTick } from "@/lib/webinar-recordings-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "webinar-recordings";
export const JOB_ID = JOB_IDS.WEBINAR_RECORDINGS;
export const SCHEDULE = "*/5 * * * *"; // every 5 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runWebinarRecordingsTick();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
