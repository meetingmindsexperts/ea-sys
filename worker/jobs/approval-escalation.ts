/**
 * approval-escalation job: the approvals primitive's assignment emails,
 * reminders, delegation, escalation and decision emails (spec §8.3).
 *
 * Cadence: every 10 minutes. Five was the first choice, but every five-minute
 * phase already has a minute carrying four jobs (the two every-minute pollers
 * plus two more), and the cadence-stagger guard caps a minute at four; the
 * ten-minute slot on :00 peaks at three before this job. The assignment email
 * is the one that has to feel prompt, and ten minutes still lands it well
 * inside the 24 hours before a reminder; when nothing is waiting a tick is a
 * lease claim and two indexed reads over a small table.
 *
 * Idempotency lives in the tick (a conditional claim before every send), not
 * here. See src/lib/approvals/approval-notifications-worker.ts.
 */
import { runApprovalNotificationsTick } from "@/lib/approvals/approval-notifications-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "approval-escalation";
export const JOB_ID = JOB_IDS.APPROVAL_ESCALATION;
export const SCHEDULE = "*/10 * * * *"; // every 10 min

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runApprovalNotificationsTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
