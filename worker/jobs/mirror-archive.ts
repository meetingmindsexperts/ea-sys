/**
 * mirror-archive job: builds the zip of the whole uploads mirror that an
 * operator requested from /admin/backups (see
 * src/lib/infra/mirror-archive-worker.ts). A poller, like scheduled-emails:
 * idle ticks cost one indexed query.
 *
 * Cadence: every three minutes, so "Build archive" starts within three. The
 * lease heartbeats while a build runs, so a multi-minute zip never looks stale.
 */
import { runMirrorArchiveTick } from "@/lib/infra/mirror-archive-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "mirror-archive";
export const JOB_ID = JOB_IDS.MIRROR_ARCHIVE;
export const SCHEDULE = "2-59/3 * * * *"; // every 3 min, offset to :02 (the stagger guard caps a minute at 4 jobs)

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runMirrorArchiveTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
