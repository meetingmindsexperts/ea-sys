/**
 * crm-contact-score job: the nightly repair of the stored contact score that
 * the CRM contacts list sorts by (src/crm/contact-score-worker.ts).
 *
 * Cadence: 02:20 UTC daily. Every write already refreshes the score, so this
 * is a safety net, and a quiet hour is enough.
 *
 * One of the CRM job shims allowed to import @/crm (docs/CRM_MODULE_PLAN.md
 * §7.0; the ESLint import-boundary rule lists it).
 */

import { runContactScoreTick } from "@/crm/contact-score-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "crm-contact-score";
export const JOB_ID = JOB_IDS.CRM_CONTACT_SCORE;
export const SCHEDULE = "20 2 * * *"; // 02:20 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runContactScoreTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
