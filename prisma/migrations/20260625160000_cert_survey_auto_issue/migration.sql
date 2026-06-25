-- Phase 2 — survey-gated certificate auto-issue.
-- All additive / nullable / idempotent → blue-green safe. The only non-add
-- changes are two NOT-NULL drops (always safe + idempotent): old code keeps
-- inserting non-null issuer values into the now-nullable columns, and only the
-- NEW worker creates auto-issue rows (with a null issuer), so the dual-running
-- deploy window never reads a null issuer through old code.

-- (1) Per-template auto-issue config (opt-in, off by default).
ALTER TABLE "CertificateTemplate" ADD COLUMN IF NOT EXISTS "autoIssueOnSurvey" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CertificateTemplate" ADD COLUMN IF NOT EXISTS "autoIssueTag" TEXT;

-- (2) Run-level auto-issue flag + nullable operator (auto runs have no operator
--     and skip the AWAITING_REVIEW gate).
ALTER TABLE "CertificateIssueRun" ADD COLUMN IF NOT EXISTS "autoIssue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CertificateIssueRun" ALTER COLUMN "triggeredByUserId" DROP NOT NULL;

-- (3) Auto-issued certs have no human issuer.
ALTER TABLE "IssuedCertificate" ALTER COLUMN "issuedByUserId" DROP NOT NULL;

-- (4) Sweep driver + retry/backoff state. The cert worker scans registrations
--     that completed the survey but aren't terminally checked and are past
--     their backoff gate, processes them, then either stamps
--     certAutoIssueCheckedAt (terminal) or defers via certAutoIssueNextAttemptAt
--     with an incremented attempts counter (exponential backoff).
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "certAutoIssueCheckedAt" TIMESTAMP(3);
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "certAutoIssueAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "certAutoIssueNextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "certAutoIssueError" TEXT;

-- Partial index keeps the sweep cheap: after the first pass nearly all rows have
-- certAutoIssueCheckedAt set, so the matching (pending) set stays tiny.
CREATE INDEX IF NOT EXISTS "Registration_cert_autoissue_pending_idx"
  ON "Registration" ("eventId")
  WHERE "certAutoIssueCheckedAt" IS NULL AND "surveyCompletedAt" IS NOT NULL;
