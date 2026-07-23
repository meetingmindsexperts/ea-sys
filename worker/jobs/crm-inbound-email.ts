/**
 * crm-inbound-email job — drains SES-received sponsor replies from S3 into the
 * CRM inbox (threads resolved by reply token). Dormant while
 * CRM_INBOUND_S3_BUCKET is unset.
 *
 * Cadence: every minute — a reply landing in the inbox within ~60s feels live;
 * the idle tick is one cheap ListObjectsV2 (or a pure no-op without the env).
 *
 * Per-object failure isolation + the s3Key dedupe live in the tick
 * (src/crm/inbound-email-worker.ts). CRM-module core-side touch point, like
 * crm-reminders — the ESLint import boundary exempts worker jobs deliberately.
 */

import { runTick } from "@/crm/inbound-email-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "crm-inbound-email";
export const JOB_ID = JOB_IDS.CRM_INBOUND_EMAIL;
export const SCHEDULE = "* * * * *"; // every minute

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
