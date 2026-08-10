-- JobLease — the worker's job-locking mechanism (replaces pg_try_advisory_lock).
--
-- Additive + idempotent: creates one small table, touches nothing existing, so
-- it is safe to apply while the old code is still running (blue-green). The old
-- advisory locks simply stop being consulted once the new worker image is live;
-- any stale ones die with their connections when the worker restarts.
--
-- No organizationId by design: this is platform infrastructure shared by every
-- tenant, not tenant data — see the model doc in schema.prisma.

CREATE TABLE IF NOT EXISTS "JobLease" (
  "job"         TEXT NOT NULL,
  "owner"       TEXT,
  "lockedUntil" TIMESTAMP(3),
  "acquiredAt"  TIMESTAMP(3),
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JobLease_pkey" PRIMARY KEY ("job")
);

-- Supports the "which leases are expired?" scan used by observability queries.
-- The claim itself goes through the primary key, so it needs no index of its own.
CREATE INDEX IF NOT EXISTS "JobLease_lockedUntil_idx" ON "JobLease"("lockedUntil");
