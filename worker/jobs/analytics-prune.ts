/**
 * analytics-prune job — retention for measured page hits.
 *
 * Cadence: 03:15 UTC daily. It takes the slot BEFORE the existing retention
 * ladder (email-log 03:45, login-event 04:15, system-log 04:45,
 * resident-letter 05:05) rather than joining it: this table produces far more
 * rows a day than any of those, so it gets room instead of contending with
 * another sweep for the same DB window. It also lands well before the 05:30
 * daily digest, so a capped sweep is visible that same morning.
 *
 * Deletes `AnalyticsEvent` rows older than 400 days. Batched + per-tick capped;
 * self-healing (a missed run catches up next tick). See the worker module for
 * why the window is longer than the other sweeps.
 */

import { runAnalyticsPruneTick } from "@/lib/analytics-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "analytics-prune";
export const JOB_ID = JOB_IDS.ANALYTICS_PRUNE;
export const SCHEDULE = "15 3 * * *"; // 03:15 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runAnalyticsPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
