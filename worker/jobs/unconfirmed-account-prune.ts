/**
 * unconfirmed-account-prune job: removes accounts made at /signup that were
 * never confirmed within 30 days (src/lib/unconfirmed-account-prune-worker.ts).
 *
 * Cadence: 04:35 UTC daily, between agent-run-prune (04:30) and
 * system-log-prune (04:45) so the retention sweeps never share a window.
 */

import { runUnconfirmedAccountPruneTick } from "@/lib/unconfirmed-account-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "unconfirmed-account-prune";
export const JOB_ID = JOB_IDS.UNCONFIRMED_ACCOUNT_PRUNE;
export const SCHEDULE = "35 4 * * *"; // 04:35 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runUnconfirmedAccountPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
