/**
 * contacts-central-sync job — mirrors EA-SYS contacts (touched in the last
 * ~30 min) into the external `contacts_centralv1` table via the target's
 * `ea_upsert_contacts` RPC. No-ops unless CONTACTS_CENTRAL_ENABLED=true +
 * URL/key are set. Failure-isolated: a tick error never crashes the scheduler.
 *
 * Cadence: fires at :16 and :53 each hour (37 min apart, ~37-min cadence),
 * deliberately OFF the top of the hour and off the every-3/5/10-min jobs so we
 * don't pile onto the DB pool at a shared minute. The tick's 45-min lookback
 * covers the 37-min max gap. A nightly full reconcile (separate job) catches
 * anything outside the window.
 */

import { runContactsCentralTick } from "@/lib/contacts-central-sync";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "contacts-central-sync";
export const JOB_ID = JOB_IDS.CONTACTS_CENTRAL_SYNC;
export const SCHEDULE = "16,53 * * * *"; // :16 and :53 — offset from :00

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runContactsCentralTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
