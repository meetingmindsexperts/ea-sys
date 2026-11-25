/**
 * stream-recording-retention job: deletes recordings of a partner's stream
 * past their 12 months, and files under recordings/ that no recording claims
 * (Nov 25, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md D4). See
 * src/lib/webinar/stream-recording-retention.ts.
 *
 * Cadence: daily at 04:40 UTC, beside the other nightly clean-ups.
 */
import { runStreamRecordingRetention } from "@/lib/webinar/stream-recording-retention";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "stream-recording-retention";
export const JOB_ID = JOB_IDS.STREAM_RECORDING_RETENTION;
export const SCHEDULE = "40 4 * * *"; // 04:40 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      const report = await runStreamRecordingRetention();
      apiLogger.info({ ...report, job: JOB_NAME }, "stream-recording-retention:tick");
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
