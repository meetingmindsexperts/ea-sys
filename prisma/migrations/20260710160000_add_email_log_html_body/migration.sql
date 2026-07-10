-- Audit copy of the final rendered HTML for opt-in senders (certificate
-- deliveries). Additive + idempotent — blue-green safe.
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "htmlBody" TEXT;
