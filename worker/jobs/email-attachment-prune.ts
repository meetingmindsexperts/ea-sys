/**
 * email-attachment-prune job: collects operator-picked email attachments no
 * queued send still references (see src/lib/email-attachment-prune-worker.ts).
 *
 * Cadence: 05:15 UTC daily, between resident-letter-prune (05:05) and the
 * daily digest (05:30) so the digest reports a swept prefix.
 */
import { runEmailAttachmentPruneTick } from "@/lib/email-attachment-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "email-attachment-prune";
export const JOB_ID = JOB_IDS.EMAIL_ATTACHMENT_PRUNE;
export const SCHEDULE = "15 5 * * *"; // 05:15 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runEmailAttachmentPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
