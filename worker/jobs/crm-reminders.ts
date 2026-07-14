/**
 * crm-reminders job — emails a CRM task's owner when the follow-up falls due.
 *
 * Cadence: every 5 minutes. A reminder is a nudge, not an alarm — sub-minute
 * precision buys nothing, and a 5-minute tick keeps the poll cheap.
 *
 * Idempotency lives in the tick (a conditional claim on `remindedAt`), not here.
 * See src/crm/reminders-worker.ts for why the row is CLAIMED BEFORE the send.
 *
 * This is one of the three permitted core-side touch points for the CRM module
 * (docs/CRM_MODULE_PLAN.md §7.0) — hence the @/crm import, which the ESLint
 * import-boundary rule exempts this file for, deliberately.
 */

import { runTick } from "@/crm/reminders-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "crm-reminders";
export const JOB_ID = JOB_IDS.CRM_REMINDERS;
export const SCHEDULE = "*/5 * * * *"; // every 5 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runTick();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
