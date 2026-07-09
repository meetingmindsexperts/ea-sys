/**
 * Persisted worker-tick records — one JobRun row per tick, written by
 * withJobLock. Powers the Infra / Ops "Cron / Jobs" card: did each cron
 * run, when, and did it fail. Successful ticks log at debug (which the
 * SystemLog writer skips), so this table is the reliable "last good run"
 * source. Failure-isolated: a recording failure never breaks the job.
 * Docs: docs/INFRA_OPS.md.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export async function recordJobRun(input: {
  job: string;
  startedAt: Date;
  status: "OK" | "FAILED";
  durationMs: number;
  error?: string;
}): Promise<void> {
  try {
    await db.jobRun.create({
      data: {
        job: input.job,
        startedAt: input.startedAt,
        finishedAt: new Date(),
        status: input.status,
        durationMs: input.durationMs,
        error: input.error ? input.error.slice(0, 2000) : null,
      },
    });
  } catch (err) {
    // Never let bookkeeping break a job — just log it.
    apiLogger.warn({ err, job: input.job, msg: "worker:job-run-record-failed" });
  }
}

/** Delete JobRun rows older than `olderThanDays` (called hourly). */
export async function pruneJobRuns(olderThanDays = 14): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const res = await db.jobRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
    return res.count;
  } catch (err) {
    apiLogger.warn({ err, msg: "worker:job-run-prune-failed" });
    return 0;
  }
}
