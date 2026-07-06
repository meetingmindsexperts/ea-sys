/**
 * contacts-central-reconcile job — nightly FULL push of every EA-SYS contact
 * into `contacts_centralv1` (union+enrich). The safety net that makes the mirror
 * self-healing: anything the ~37-min incremental ticks missed (a transient
 * failure outside the lookback window, a worker restart) is corrected here.
 * No-ops unless CONTACTS_CENTRAL_ENABLED + URL/key are set. Failure-isolated.
 *
 * Own lock id (not shared with the incremental) so it can never be skipped by an
 * in-flight incremental tick.
 *
 * Cadence: daily at 02:00 UTC (06:00 Asia/Dubai).
 */

import { runContactsCentralReconcile } from "@/lib/contacts-central-sync";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "contacts-central-reconcile";
export const JOB_ID = JOB_IDS.CONTACTS_CENTRAL_RECONCILE;
export const SCHEDULE = "0 2 * * *"; // daily 02:00 UTC

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runContactsCentralReconcile();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
