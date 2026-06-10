/**
 * cert-issue job — drives all CertificateIssueRun rows through their
 * state machine (PENDING → RENDERING → AWAITING_REVIEW → SENDING →
 * COMPLETED, plus FAILED + CANCELLED branches).
 *
 * Cadence: every 3 minutes (was every 1 minute). Cert issuance is
 * post-event and not latency-critical, so a new run starting within
 * ~3 min of the operator clicking Issue is fine — and the slower cadence
 * cuts this job's idle lock-acquire polls (and its collisions with the
 * every-minute scheduled-emails job) on the worker's shared connection
 * pool by 3×. The underlying `tickAllRuns` handles its own per-item
 * batching + stall detection.
 */

import { tickAllRuns } from "@/lib/certificates/issue-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "cert-issue";
export const JOB_ID = JOB_IDS.CERT_ISSUE;
export const SCHEDULE = "*/3 * * * *"; // every 3 minutes

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
