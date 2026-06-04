/**
 * cert-issue job — drives all CertificateIssueRun rows through their
 * state machine (PENDING → RENDERING → AWAITING_REVIEW → SENDING →
 * COMPLETED, plus FAILED + CANCELLED branches).
 *
 * Cadence: every 1 minute (matches the legacy crontab line). The
 * underlying `tickAllRuns` handles its own per-item batching + stall
 * detection.
 */

import { tickAllRuns } from "@/lib/certificates/issue-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "cert-issue";
export const JOB_ID = JOB_IDS.CERT_ISSUE;
export const SCHEDULE = "* * * * *"; // every minute

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await tickAllRuns();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
