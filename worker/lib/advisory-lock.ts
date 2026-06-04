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
 */

import { db } from "@/lib/db";
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
  const result = await db.$queryRaw<[{ locked: boolean }]>`
    SELECT pg_try_advisory_lock(${jobId}) AS locked
  `;
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
