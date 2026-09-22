/**
 * quickbooks-health job: keeps each organisation's QuickBooks connection
 * alive and records whether it still works.
 *
 * Cadence: 05:10 UTC daily, between the retention sweeps (04:45) and the
 * daily digest (05:30), so a connection that broke overnight is already
 * recorded when the digest is written.
 */
import { runQuickBooksHealthTick } from "@/procurement/integrations/quickbooks/health-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "quickbooks-health";
export const JOB_ID = JOB_IDS.QUICKBOOKS_HEALTH;
export const SCHEDULE = "10 5 * * *"; // 05:10 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runQuickBooksHealthTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
