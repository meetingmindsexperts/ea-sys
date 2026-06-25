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
import { runAutoIssueSweep } from "@/lib/certificates/auto-issue";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "cert-issue";
export const JOB_ID = JOB_IDS.CERT_ISSUE;
export const SCHEDULE = "*/3 * * * *"; // every 3 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    // (1) Survey-gated auto-issue sweep — enqueue any newly-eligible certs
    //     as autoIssue runs. Isolated from (2): a sweep failure must not
    //     stop the existing manual runs from draining.
    try {
      await runAutoIssueSweep();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME, phase: "auto-issue-sweep" });
    }
    // (2) Drain all CertificateIssueRun rows (manual + the auto runs the
    //     sweep just created) through their render/email state machine.
    try {
      await tickAllRuns();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME, phase: "drain-runs" });
    }
  });
}
