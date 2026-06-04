/**
 * oauth-cleanup job — hourly GC of expired MCP OAuth auth codes and
 * access tokens past their 7-day grace period.
 *
 * Cadence: hourly at minute 0 (matches the legacy crontab line). Two
 * trivial deleteMany calls; runtime cost is microseconds.
 */

import { runMcpOAuthCleanupTick } from "@/lib/mcp-oauth-cleanup-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "oauth-cleanup";
export const JOB_ID = JOB_IDS.OAUTH_CLEANUP;
export const SCHEDULE = "0 * * * *"; // every hour at :00

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runMcpOAuthCleanupTick();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
  });
}
