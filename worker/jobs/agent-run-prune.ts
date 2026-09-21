/**
 * agent-run-prune job — retention for the Event Agent's stored runs.
 *
 * Cadence: 04:30 UTC daily, between login-event-prune (04:15) and
 * system-log-prune (04:45) so the retention sweeps never share a DB window.
 *
 * Deletes `AgentRun` rows older than 180 days; their `AgentStep` rows go with
 * them (FK cascade). Batched + per-tick capped; self-healing.
 */

import { runAgentRunPruneTick } from "@/lib/agent-run-prune-worker";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "agent-run-prune";
export const JOB_ID = JOB_IDS.AGENT_RUN_PRUNE;
export const SCHEDULE = "30 4 * * *"; // 04:30 UTC daily

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runAgentRunPruneTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
