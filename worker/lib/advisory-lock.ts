/**
 * Postgres advisory-lock wrapper for worker job ticks.
 *
 * Wraps a tick function in `pg_try_advisory_lock(jobId)` →
 * fn() → `pg_advisory_unlock(jobId)`. If another worker already
 * holds the lock, the function is skipped and `null` is returned
 * — never blocks.
 *
 * Why advisory locks (and not application-level "is this row
 * already being processed" checks):
 *   1. No new schema — uses Postgres primitives we already have
 *   2. Session-scoped: a crashed worker auto-releases at connection
 *      close, so we don't get stuck "held by ghost" locks
 *   3. Symmetric: works whether 1 or N workers are running, so the
 *      dual-write window (route + worker both firing) and the
 *      Singapore DR case (Mumbai + Singapore both up) just work
 *
 * Per docs/WORKER_EXTRACTION_PLAN.md §3 — "the worker's singleton
 * guarantee is enforced by Postgres, not by process management."
 *
 * ⚠️ KNOWN LIMITATION — "P3" (2026-06-09): advisory locks are SESSION-
 * scoped, but the worker's Prisma client connects through the Supabase
 * TRANSACTION pooler (port 6543, pgbouncer=true). In transaction-pooling
 * mode each statement can land on a different backend session, so the
 * lock taken by pg_try_advisory_lock and the matching pg_advisory_unlock
 * may run on different backends — the unlock no-ops and the contention
 * check is unreliable. So point (2) above ("session-scoped auto-release")
 * and the cross-runner half of point (3) do NOT actually hold through
 * this pooler. It hasn't bitten us because (a) the duplicate /api/cron/*
 * runners were disabled 2026-06-09 (worker is now the sole runner) and
 * (b) a single worker process never contends with itself. To make the
 * guarantee real — required before running a 2nd worker (e.g. Singapore
 * DR failover) — give the lock a SESSION-mode connection by pointing the
 * worker at DIRECT_URL (port 5432). That also removes the pooler-recycle
 * that produced the 2026-06-09 EDBHANDLEREXITED incident.
 */

import { db, classifyPrismaError } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Run `fn` if and only if we can acquire the advisory lock for `jobId`.
 * Returns the function's result, or `null` if the lock was already held
 * by another session (we politely skip).
 *
 * NEVER throws on a contended lock — that's the design. Only throws if
 * `fn` itself throws OR the Postgres call itself fails. The caller's
 * own try/catch should still handle errors from inside fn.
 */
export async function withJobLock<T>(
  jobId: number,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  // pg_try_advisory_lock returns boolean — true = we got it, false =
  // someone else holds it. We use the try-variant (not the blocking
  // pg_advisory_lock) so a stuck holder doesn't wedge the whole
  // worker process behind a held lock.
  //
  // The acquire runs OUTSIDE the caller's job-level try/catch, so a
  // transient pooler dropout here (Supabase `EDBHANDLEREXITED` /
  // `Error { kind: Closed }`) would otherwise escape all the way to the
  // scheduler's last-resort catch and fire a `worker:tick-wrapper-uncaught`
  // alert — paging a human for a self-healing blip. A closed pooled
  // connection on this query means Prisma will re-establish on the next
  // tick (5 min away), so we treat it like a contended lock: skip quietly,
  // log at `warn` (below the alert threshold), and let the next tick retry.
  // Any NON-retryable error still re-throws — those are real problems.
  let result: Array<{ locked: boolean }>;
  try {
    result = await db.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_lock(${jobId}) AS locked
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classification = classifyPrismaError(message);
    if (classification?.retryable) {
      apiLogger.warn({
        msg: "worker:lock-acquire-transient-skip",
        job: jobName,
        jobId,
        err: message,
        classification: classification.category,
      });
      return null;
    }
    throw err;
  }
  const locked = result[0]?.locked === true;

  if (!locked) {
    apiLogger.debug({
      msg: "worker:skip-tick-locked",
      job: jobName,
      jobId,
    });
    return null;
  }

  try {
    return await fn();
  } finally {
    // Best-effort unlock. If this fails (e.g., DB connection died
    // mid-tick), Postgres releases the advisory lock automatically at
    // session close, so there's no stuck-lock recovery to do — but
    // we log the failure for visibility.
    try {
      await db.$queryRaw`SELECT pg_advisory_unlock(${jobId})`;
    } catch (err) {
      apiLogger.warn({
        msg: "worker:advisory-unlock-failed",
        job: jobName,
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
