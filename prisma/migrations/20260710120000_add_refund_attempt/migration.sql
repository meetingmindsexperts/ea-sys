-- Refund attempt records — crash-safety for money movement (review H4/H5).
-- Persisted BEFORE the Stripe refund call so a crash/ambiguous outcome can be
-- verified against Stripe and reconciled by the sweep. Additive + blue-green
-- safe (new enum + table only; old code never touches them).

DO $$ BEGIN
  CREATE TYPE "RefundAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "RefundAttempt" (
  "id"                    TEXT NOT NULL,
  "registrationId"        TEXT NOT NULL,
  "paymentId"             TEXT,
  "stripePaymentIntentId" TEXT,
  "amount"                DECIMAL(10,2) NOT NULL,
  "refundedBefore"        DECIMAL(10,2) NOT NULL,
  "refundedAfter"         DECIMAL(10,2) NOT NULL,
  "flippedToRefunded"     BOOLEAN NOT NULL DEFAULT false,
  "kind"                  TEXT NOT NULL,
  "status"                "RefundAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "stripeRefundId"        TEXT,
  "error"                 TEXT,
  "source"                TEXT,
  "issuedByUserId"        TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefundAttempt_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "RefundAttempt"
    ADD CONSTRAINT "RefundAttempt_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "RefundAttempt_registrationId_idx" ON "RefundAttempt"("registrationId");
CREATE INDEX IF NOT EXISTS "RefundAttempt_status_createdAt_idx" ON "RefundAttempt"("status", "createdAt");
