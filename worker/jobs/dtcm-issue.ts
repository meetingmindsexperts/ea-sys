/**
 * dtcm-issue job: works the bulk "Generate DTCM codes" runs, buying DTCM
 * tickets from DET one registration at a time (docs/DTCM_ETICKET_PLAN.md
 * §5.3, step 4).
 *
 * Cadence: every 2 minutes on the even minutes, with a 45-second budget per
 * tick. A run of 500 people at about 5 seconds each takes roughly an hour and
 * a half, which is fine a day before the event, and keeps DET's load and our
 * pool at one purchase at a time. Every minute would break the stagger cap of
 * four jobs per minute (worker-cadence-stagger.test.ts); the odd minutes do too.
 */
import { tickAllDtcmRuns } from "@/lib/dtcm-eticket/issue-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "dtcm-issue";
export const JOB_ID = JOB_IDS.DTCM_ISSUE;
export const SCHEDULE = "0-58/2 * * * *"; // every 2 min on the even minutes (the odd ones push a minute past 4 jobs)

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await tickAllDtcmRuns();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
