-- Review C1 (July 16, 2026): ownership nonce for the scheduled-email worker.
-- The PENDING→PROCESSING claim stamps a per-claim token; heartbeat and
-- completion/failure writes condition on it, so a zombie sender that survived
-- a DB-write outage cannot clobber a row another claimant now owns.
-- Additive + idempotent — blue-green safe.
ALTER TABLE "ScheduledEmail" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
