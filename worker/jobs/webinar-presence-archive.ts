/**
 * webinar-presence-archive job — retention for the webinar page heartbeats.
 *
 * Cadence: 04:20 UTC daily, between login-event-prune (04:15) and agent-run-prune (04:30), so the
 * retention sweeps don't contend for the same DB window.
 *
 * Rows not seen for 90 days are written to a gzip file under logs/archive/webinar-presence/, then
 * removed from the table (owner: archive, never delete outright). See the worker module.
 */

import { runWebinarPresenceArchiveTick } from "@/lib/webinar/presence-archive-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "webinar-presence-archive";
export const JOB_ID = JOB_IDS.WEBINAR_PRESENCE_ARCHIVE;
export const SCHEDULE = "20 4 * * *"; // 04:20 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runWebinarPresenceArchiveTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
