/**
 * contacts-central-reconcile job — nightly 25-hour sweep into
 * `contacts_centralv1` (union+enrich), catching anything the ~37-min
 * incremental ticks missed within that window.
 *
 * ⚠️ It was a FULL push of every contact until Aug 18, 2026, which made the
 * mirror self-healing at any age. That was narrowed deliberately when the
 * inbound import took the contact store from ~3.3k to ~57k: a nightly full push
 * is ~1,200 sequential HTTP round trips to re-send rows that came FROM the
 * mirror. The cost is that a failure older than 25h is no longer repaired
 * automatically — see the docblock on runContactsCentralReconcile, and run
 * `scripts/backfill-contacts-central.ts --write` for a manual full push.
 *
 * No-ops unless CONTACTS_CENTRAL_ENABLED + URL/key are set. Failure-isolated.
 *
 * Own lock id (not shared with the incremental) so it can never be skipped by an
 * in-flight incremental tick.
 *
 * Cadence: daily at 02:24 UTC (06:24 Asia/Dubai) — offset off the top of the hour.
 */

import { runContactsCentralReconcile } from "@/lib/contacts-central-sync";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "contacts-central-reconcile";
export const JOB_ID = JOB_IDS.CONTACTS_CENTRAL_RECONCILE;
export const SCHEDULE = "24 2 * * *"; // daily 02:24 UTC

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runContactsCentralReconcile();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
