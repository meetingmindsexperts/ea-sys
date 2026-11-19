-- Email delivery reports: what the mail service said happened to an email
-- AFTER it accepted it (Nov 19, 2026).
--
-- Until now the app recorded only SENT ("handed to the mail service") or
-- FAILED ("the service refused it"). A bounce arrives later and the app never
-- heard of it: a speaker's address bounced on Oct 2 and three more emails to
-- him were logged SENT while the service dropped each one.
--
-- These columns are written only by the bounce recorder
-- (src/lib/email-delivery.ts), from the service's signed reports. Every
-- existing row keeps NULL, which reads as "nothing reported".
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new enum, five nullable columns and one
-- index on a table of about 5,000 rows; nothing existing is altered, so the
-- old container is never surprised during a blue/green swap (it names its
-- columns and never sees these). Every statement is IF NOT EXISTS or
-- DO-guarded; a re-run is a no-op.

SET lock_timeout = '10s';

DO $$ BEGIN
  CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DELIVERED', 'BOUNCED', 'COMPLAINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "deliveryStatus" "EmailDeliveryStatus";
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "deliveryAt"     TIMESTAMP(3);
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "bounceType"     TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "bounceSubType"  TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "deliveryDetail" TEXT;

-- A report names the email by the service's message id; without this index
-- every report would read the whole table.
CREATE INDEX IF NOT EXISTS "EmailLog_providerMessageId_idx" ON "EmailLog"("providerMessageId");
