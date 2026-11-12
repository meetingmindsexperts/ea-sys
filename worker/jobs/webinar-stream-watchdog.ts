/**
 * webinar-stream-watchdog job: restarts Zoom's push when an open webinar
 * room's custom stream drops (Nov 5, 2026). See src/lib/webinar/stream-watchdog.ts.
 *
 * Cadence: every minute at second 30. The other jobs all start at second 0,
 * and the stagger rule is about jobs starting together and competing for the
 * pool, so the half-minute keeps it off that crowd. A tick waits 20 s only
 * when a room needs a second look, inside the minute and the shutdown drain.
 */
import { runStreamWatchdogTick } from "@/lib/webinar/stream-watchdog";
import { sweepExternalPublishers } from "@/lib/webinar/external-stream-sweep";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "webinar-stream-watchdog";
export const JOB_ID = JOB_IDS.WEBINAR_STREAM_WATCHDOG;
export const SCHEDULE = "30 * * * * *"; // every minute, at second 30

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      const report = await runStreamWatchdogTick();
      if (report.dropped > 0 || report.restartsRequested > 0) {
        apiLogger.info({ ...report, job: JOB_NAME }, "webinar-stream-watchdog:tick");
      }
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
    // A partner's stream still running on a key that is switched off, outside its
    // period or since replaced is disconnected here (external-stream-sweep.ts). Its own try: a
    // failure of either half never stops the other.
    try {
      const swept = await sweepExternalPublishers();
      if (swept.disconnected > 0) apiLogger.info({ ...swept, job: JOB_NAME }, "webinar-stream-watchdog:external-sweep");
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME, part: "external-sweep" });
    }
  });
}
