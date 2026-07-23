-- CRM inbox go-live hardening (adversarial review July 23, 2026).
-- Additive + idempotent.
--   H2: s3Key becomes the inbound idempotency key (unique; NULLs distinct so
--       outbound rows are unaffected).
--   H1: unverifiedSender flags a message whose sender didn't verify against the
--       thread's counterparty (stored + badged, auto-forward suppressed).
--   M1: thread token lifecycle — expiresAt (rolling) + revokedAt (explicit kill).

ALTER TABLE "CrmEmailMessage" ADD COLUMN IF NOT EXISTS "unverifiedSender" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CrmEmailThread"  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "CrmEmailThread"  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);

-- Unique on s3Key. Safe: inbound rows don't exist yet (feature dormant until the
-- SES env lands) and every outbound row has s3Key = NULL (distinct in Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailMessage_s3Key_key" ON "CrmEmailMessage"("s3Key");
