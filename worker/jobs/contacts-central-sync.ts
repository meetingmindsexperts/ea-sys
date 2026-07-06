/**
 * contacts-central-sync job — mirrors EA-SYS contacts (touched in the last
 * ~30 min) into the external `contacts_centralv1` table via the target's
 * `ea_upsert_contacts` RPC. No-ops unless CONTACTS_CENTRAL_ENABLED=true +
 * URL/key are set. Failure-isolated: a tick error never crashes the scheduler.
 *
 * Cadence: ~every 37 minutes (fires at :00 and :37 each hour, so the max gap is
 * 37 min; the tick's 45-min lookback covers it). A nightly full reconcile
 * (separate job) catches anything outside the window.
 */

import { runContactsCentralTick } from "@/lib/contacts-central-sync";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "contacts-central-sync";
export const JOB_ID = JOB_IDS.CONTACTS_CENTRAL_SYNC;
export const SCHEDULE = "*/37 * * * *"; // ~every 37 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runContactsCentralTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
