/**
 * crm-retention job: applies each organisation's CRM data retention periods
 * (src/crm/retention-worker.ts). OFF until an organisation sets a period.
 *
 * Cadence: 03:10 UTC daily, a quiet hour.
 *
 * One of the CRM job shims allowed to import @/crm (docs/CRM_MODULE_PLAN.md
 * §7.0; the ESLint import-boundary rule lists it).
 */

import { runRetentionTick } from "@/crm/retention-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "crm-retention";
export const JOB_ID = JOB_IDS.CRM_RETENTION;
export const SCHEDULE = "10 3 * * *"; // 03:10 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runRetentionTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
