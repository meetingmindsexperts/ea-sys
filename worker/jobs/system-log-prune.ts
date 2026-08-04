/**
 * system-log-prune job — retention for the SystemLog table.
 *
 * Cadence: 04:45 UTC daily, deliberately offset from email-log-prune (03:45)
 * and login-event-prune (04:15) so the retention sweeps don't contend for
 * the same DB window.
 *
 * Deletes `SystemLog` rows older than 30 days — the table is written by the
 * logger's warn+ DB stream (both web + worker containers) to feed the
 * /admin/infra error-trend + abuse cards and the /logs database source.
 */

import { runSystemLogPruneTick } from "@/lib/system-log-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "system-log-prune";
export const JOB_ID = JOB_IDS.SYSTEM_LOG_PRUNE;
export const SCHEDULE = "45 4 * * *"; // 04:45 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runSystemLogPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
