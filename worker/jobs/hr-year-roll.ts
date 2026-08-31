/**
 * hr-year-roll job — carries each leave year's closing balance into the next.
 *
 * Cadence: 01:05 UTC daily (05:05 Dubai), but it only acts in JANUARY, when it
 * rolls the previous leave year into the current one every night so late
 * December entries correct the grant. Outside January it is a no-op tick, and
 * on a deployment where the HR module is off it returns immediately.
 *
 * Deliberately ahead of the retention sweeps (03:45 onwards) and the digest
 * (05:30): the roll is a write that the digest's numbers may depend on.
 */

import { runHrYearRollTick } from "@/hr/hr-year-roll-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "hr-year-roll";
export const JOB_ID = JOB_IDS.HR_YEAR_ROLL;
export const SCHEDULE = "5 1 * * *"; // 01:05 UTC daily; acts in January only

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runHrYearRollTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
