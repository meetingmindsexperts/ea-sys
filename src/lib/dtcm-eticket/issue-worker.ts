/**
 * The dtcm-issue worker's body (docs/DTCM_ETICKET_PLAN.md §5.3, step 4).
 *
 * The scan of RUNNING runs crosses tenants, so it reads through `dbOperator`
 * (allowlisted in scripts/check-tenant-als.sh, the certificate worker's
 * shape). Each run is then worked inside its OWN organisation's lane, so every
 * write stays under RLS on the platform instance.
 *
 * Runs are worked one after another, never in parallel: DET is a government
 * API behind a whitelist, and the Laravel app's one recorded regret was
 * dispatching everything at once.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { tickDtcmRun } from "@/services/dtcm-issue-run-service";

/** Per tick, across all runs: the job fires every 2 minutes and the budget stays well inside that. */
const TICK_BUDGET_MS = 45_000;

/**
 * Set on SIGTERM (a deploy restarts the worker). No NEW purchase starts after
 * it; the one in flight finishes if the 25-second drain allows, and if it does
 * not, the next tick finds its PENDING order and stops the run for a person.
 */
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
});

export async function tickAllDtcmRuns(): Promise<{ runs: number }> {
  const runs = await dbOperator.dtcmIssueRun.findMany({
    where: { status: "RUNNING" },
    select: { id: true, organizationId: true },
    orderBy: { startedAt: "asc" },
  });
  const deadline = Date.now() + TICK_BUDGET_MS;
  for (const run of runs) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      if (stopping) break;
      await runWithTenantLane(run.organizationId, { route: "dtcm-eticket:issue-worker" }, () =>
        tickDtcmRun(run.id, left, undefined, () => stopping),
      );
    } catch (err) {
      // One run's failure must not stop the others. A purchase that threw has
      // already STOPPED its run (tickDtcmRun); anything earlier (reading the
      // run or DET's map) leaves it RUNNING for the next tick, and every
      // purchase still goes through the activeKey insert.
      apiLogger.error({ err, runId: run.id, msg: "dtcm-run:tick-failed" });
    }
  }
  return { runs: runs.length };
}
