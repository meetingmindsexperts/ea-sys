/**
 * stream-recording-finish job: makes the MP4 of each finished recording of a
 * partner's stream (Nov 25, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4).
 * See src/lib/webinar/stream-recording-finish.ts.
 *
 * Cadence: every minute at second 45, off the shipping job's :15 and the
 * stream watchdog's :30.
 */
import { finishStreamRecordingArchives } from "@/lib/webinar/stream-recording-finish";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "stream-recording-finish";
export const JOB_ID = JOB_IDS.STREAM_RECORDING_FINISH;
export const SCHEDULE = "45 * * * * *"; // every minute, at second 45

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      const report = await finishStreamRecordingArchives();
      if (report.checked > report.waiting + report.skipped) {
        apiLogger.info({ ...report, job: JOB_NAME }, "stream-recording-finish:tick");
      }
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
