/**
 * Job leases — "only one runner at a time", done in a way that survives
 * connection pooling.
 *
 * ── What this replaces, and why ──────────────────────────────────────────
 * Until 2026-08-10 this was `pg_try_advisory_lock(jobId)`. Advisory locks are
 * SESSION-scoped: the connection that TAKES the lock must be the one that
 * RELEASES it. Prisma hands out whichever pooled connection is free, so the
 * release routinely ran on a connection that had never held the lock. The
 * release silently did nothing, the original connection kept the lock while
 * sitting idle, and every subsequent tick found the job "already running" and
 * skipped.
 *
 * Measured on production before the change (24h): `scheduled-emails` ran 435
 * times against a schedule of 1,440; `crm-inbound-email` 375 of 1,440;
 * `cert-issue` 182 of 480. Hourly and daily jobs were exact — the shortfall
 * scaled with how often a job ran, because frequent jobs mean a busy pool.
 * Nothing ever FAILED, so every health surface reported green.
 *
 * Moving the worker off the pgbouncer transaction pooler onto a session-mode
 * connection narrowed it but did not fix it — the split happens inside
 * Prisma's own pool, below the pooler. Verified twice: in a probe (idle pool →
 * release succeeds; busy pool → acquire on pid 14731, release on pid 14727,
 * release returns false) and then on prod, where three locks were caught held
 * by connections that had been idle for minutes.
 *
 * ── Why a lease is structurally correct ──────────────────────────────────
 * Claiming is ONE statement — `INSERT … ON CONFLICT DO UPDATE … WHERE
 * expired-or-free`. A single statement is its own transaction, so it is atomic
 * no matter which connection executes it, and "which connection" stops being a
 * concept that can go wrong.
 *
 * It also fixes the failure mode the advisory lock never had a story for: a
 * lease EXPIRES. A worker that is SIGKILLed mid-tick leaves a lease behind, and
 * that lease frees itself at `lockedUntil` instead of wedging the job until
 * someone notices. Long ticks extend it with a heartbeat, so "expired" always
 * means "the holder stopped existing", never "the holder is just slow".
 *
 * ── The invariants ───────────────────────────────────────────────────────
 *   1. Every mutation is conditional on `owner`. A tick whose lease expired
 *      cannot release or extend the lease its successor now holds — without
 *      this, a slow tick finishing late would hand its replacement's lease
 *      away mid-run, which is exactly the double-run this file prevents.
 *   2. Claiming never throws on contention — it returns false and the tick
 *      skips, same contract the advisory lock had.
 *   3. A transient DB error on claim is a skip, not a crash: the acquire runs
 *      outside the job's own try/catch, so an unhandled error here would reach
 *      the scheduler's last-resort catch and page a human for a blip that heals
 *      by itself on the next tick.
 */

import { randomUUID } from "crypto";
import { db, classifyPrismaError } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordJobRun } from "@/lib/job-run";

/**
 * How long a claimed lease stays valid without a heartbeat.
 *
 * Sized against the two failure modes it sits between: too short and a tick
 * that pauses (a slow SES batch, a Zoom API stall) loses its lease to a
 * concurrent tick; too long and a killed worker's job stays stuck. Five minutes
 * with a 60s heartbeat means a live tick renews five times over before expiry,
 * while a dead one is reclaimed within five minutes.
 */
export const LEASE_TTL_MS = 5 * 60 * 1000;

/** Renewal interval while a tick is running. Must be well under the TTL. */
export const LEASE_HEARTBEAT_MS = 60 * 1000;

/**
 * Try to claim `job` for `owner`.
 *
 * ONE statement, so it is atomic regardless of connection: insert the row if
 * this job has never run, otherwise take it over only if the existing lease is
 * free (`owner IS NULL`) or expired. `RETURNING` yields a row only when the
 * conflict-update's WHERE passed — i.e. only when we actually won it.
 */
export async function claimLease(
  job: string,
  owner: string,
  ttlMs: number = LEASE_TTL_MS,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ job: string }>>`
    INSERT INTO "JobLease" ("job", "owner", "lockedUntil", "acquiredAt", "updatedAt")
    VALUES (${job}, ${owner}, now() + (${ttlMs} * interval '1 millisecond'), now(), now())
    ON CONFLICT ("job") DO UPDATE
      SET "owner"       = ${owner},
          "lockedUntil" = now() + (${ttlMs} * interval '1 millisecond'),
          "acquiredAt"  = now(),
          "updatedAt"   = now()
      WHERE "JobLease"."owner" IS NULL
         OR "JobLease"."lockedUntil" IS NULL
         OR "JobLease"."lockedUntil" < now()
    RETURNING "job"
  `;
  return rows.length > 0;
}

/**
 * Push the expiry out while a tick is still working.
 * Conditional on `owner` — invariant 1: never extend someone else's lease.
 */
export async function renewLease(
  job: string,
  owner: string,
  ttlMs: number = LEASE_TTL_MS,
): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "JobLease"
       SET "lockedUntil" = now() + (${ttlMs} * interval '1 millisecond'),
           "updatedAt"   = now()
     WHERE "job" = ${job} AND "owner" = ${owner}
  `;
  return n > 0;
}

/**
 * Hand the lease back.
 * Conditional on `owner` — invariant 1: a tick that overran its lease must not
 * release the successor that legitimately took over from it.
 */
export async function releaseLease(job: string, owner: string): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "JobLease"
       SET "owner" = NULL, "lockedUntil" = NULL, "updatedAt" = now()
     WHERE "job" = ${job} AND "owner" = ${owner}
  `;
  return n > 0;
}

/**
 * Run `fn` if and only if we can claim this job's lease. Returns the function's
 * result, or `null` if another tick holds it (we skip, quietly and by design).
 *
 * Signature is unchanged from the advisory-lock version so no job file needed
 * touching. `jobId` is no longer a lock identifier — it is kept because it is a
 * stable numeric id for log correlation and because the JOB_IDS registry is a
 * useful place to see every job at a glance.
 */
export async function withJobLease<T>(
  jobId: number,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const owner = randomUUID();

  let claimed: boolean;
  try {
    claimed = await claimLease(jobName, owner);
  } catch (err) {
    // Invariant 3. A closed pooled connection here means Prisma re-establishes
    // by the next tick, so treat it like contention rather than paging a human.
    const message = err instanceof Error ? err.message : String(err);
    const classification = classifyPrismaError(message);
    if (classification?.retryable) {
      apiLogger.warn({
        msg: "worker:lease-claim-transient-skip",
        job: jobName,
        jobId,
        err: message,
        classification: classification.category,
      });
      return null;
    }
    throw err;
  }

  if (!claimed) {
    // Expected and healthy in one case: the previous tick of THIS job is still
    // running (a 4-minute tick simply skips three). Logged at warn rather than
    // the historical debug because debug reached neither /logs nor CloudWatch
    // nor the daily digest — which is precisely how a 70% skip rate stayed
    // invisible for months. Should now be rare; if it is ever constant again,
    // that is the signal we previously lacked.
    apiLogger.warn({ msg: "worker:skip-tick-leased", job: jobName, jobId });
    return null;
  }

  // Keep the lease alive for as long as the tick runs, so "expired" can only
  // ever mean "the holder died" — never "the holder is slow". unref() so a
  // pending timer can't hold the process open during shutdown.
  const heartbeat = setInterval(() => {
    void renewLease(jobName, owner).then(
      (ok) => {
        if (!ok) {
          // We lost the lease mid-tick — it expired and someone else claimed
          // it. Surface it: it means TTL is too short for this job's real
          // runtime, and two ticks may now be running concurrently.
          apiLogger.error({
            msg: "worker:lease-lost-mid-tick",
            job: jobName,
            jobId,
            detail:
              "Lease expired while the tick was still running and was taken by " +
              "another tick. Raise LEASE_TTL_MS or investigate why the tick " +
              "outran its heartbeat.",
          });
        }
      },
      (err) => apiLogger.warn({ msg: "worker:lease-renew-failed", job: jobName, jobId, err }),
    );
  }, LEASE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // We hold the lease → this tick actually ran. Record its outcome (one JobRun
  // row) for the Infra / Ops "Cron / Jobs" card and the daily digest's
  // expected-vs-actual check. Skips are NOT recorded — they are logged, not
  // runs. Recording is failure-isolated inside recordJobRun.
  const startedAt = new Date();
  const t0 = Date.now();
  try {
    const out = await fn();
    await recordJobRun({ job: jobName, startedAt, status: "OK", durationMs: Date.now() - t0 });
    return out;
  } catch (err) {
    await recordJobRun({
      job: jobName,
      startedAt,
      status: "FAILED",
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
    // Best-effort release. Unlike the advisory lock this replaced, a failure
    // here is self-correcting: the lease expires at LEASE_TTL_MS and the job
    // resumes on its own. Worth a log, not worth a retry loop.
    try {
      await releaseLease(jobName, owner);
    } catch (err) {
      apiLogger.warn({ msg: "worker:lease-release-failed", job: jobName, jobId, err });
    }
  }
}

/** Back-compat alias — the job files call this name. */
export const withJobLock = withJobLease;
