-- Approvals, Phase 2: notifications, reminders, delegation and escalation
-- (spec §8.3). Additive and idempotent; blue-green safe (nullable columns and
-- two indexes, nothing renamed or dropped).
--
-- The two notification markers are BACKFILLED for rows that already exist, so
-- the worker never mails an assignment or a decision that happened before it
-- was deployed. Each backfill is gated on its column not existing yet, so it
-- runs exactly once: a bare "WHERE notifiedAt IS NULL" on a re-run would also
-- silence steps created in between.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "procurementDelegateUserId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ApprovalStep' AND column_name = 'notifiedAt'
  ) THEN
    ALTER TABLE "ApprovalStep" ADD COLUMN "notifiedAt" TIMESTAMP(3);
    UPDATE "ApprovalStep" SET "notifiedAt" = "createdAt";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ApprovalRequest' AND column_name = 'decisionNotifiedAt'
  ) THEN
    ALTER TABLE "ApprovalRequest" ADD COLUMN "decisionNotifiedAt" TIMESTAMP(3);
    UPDATE "ApprovalRequest" SET "decisionNotifiedAt" = COALESCE("decidedAt", "createdAt") WHERE "status" <> 'PENDING';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ApprovalStep_status_notifiedAt_idx" ON "ApprovalStep"("status", "notifiedAt");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_status_decisionNotifiedAt_idx" ON "ApprovalRequest"("status", "decisionNotifiedAt");
