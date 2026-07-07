/**
 * log-archive job — monthly archival of the SystemLog table.
 *
 * Cadence: 03:30 UTC on the 1st of each month. Keeps the current + previous
 * month live and moves every older month into a gzip-JSONL file under
 * `logs/archive/` (then deletes those rows), so the hot `/logs` table stays
 * bounded while every log is retained inside the system. Self-healing: it
 * archives ALL months older than the cutoff, so a missed run catches up.
 */

import { runLogArchiveTick } from "@/lib/log-archive";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "log-archive";
export const JOB_ID = JOB_IDS.LOG_ARCHIVE;
export const SCHEDULE = "30 3 1 * *"; // 03:30 on the 1st of each month

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runLogArchiveTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
