/**
 * resident-letter-prune job — collects abandoned supporting-document uploads.
 *
 * Cadence: 05:05 UTC daily, offset from the other retention sweeps
 * (email-log 03:45, login-event 04:15, system-log 04:45) so they don't
 * contend, and before the daily digest at 05:30 so its report reflects a
 * swept disk.
 *
 * Unlike its neighbours this deletes FILES, not rows: the public upload
 * endpoint necessarily writes before the registration exists, so every
 * abandoned form leaves one behind. Only files no registration references AND
 * older than the grace window are removed — see the worker module.
 *
 * JOB_NAME stays `resident-letter-prune` after the Aug 13 2026 generalisation,
 * deliberately. It is a KEY, not a label: `JobRun.job` rows carry it as
 * history, and `EXPECTED_JOBS` in src/lib/worker-jobs.ts matches on it for the
 * daily digest's expected-vs-actual cadence check. Renaming would orphan the
 * history and risk the digest reporting the job as missing — a cosmetic gain
 * paid for with a false alarm. Same reasoning as the storage prefix.
 */

import { runSupportingDocumentPruneTick } from "@/lib/supporting-document-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "resident-letter-prune";
export const JOB_ID = JOB_IDS.RESIDENT_LETTER_PRUNE;
export const SCHEDULE = "5 5 * * *"; // 05:05 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runSupportingDocumentPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
