/**
 * stream-recording-ship job: ships the pieces of every recording of a
 * partner's stream from the stream server's buffer to S3 (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md). See src/lib/webinar/stream-recording-ship.ts.
 *
 * Cadence: every minute at second 15, off the :00 crowd and the stream
 * watchdog's :30. A run takes at most about 20 seconds.
 */
import { shipStreamRecordings } from "@/lib/webinar/stream-recording-ship";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "stream-recording-ship";
export const JOB_ID = JOB_IDS.STREAM_RECORDING_SHIP;
export const SCHEDULE = "15 * * * * *"; // every minute, at second 15

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      const report = await shipStreamRecordings();
      if (report.shipped > 0 || report.discarded > 0 || report.waiting > 0) {
        apiLogger.info({ ...report, job: JOB_NAME }, "stream-recording-ship:tick");
      }
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
