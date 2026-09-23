-- Budget & Procurement: a durable record of a purchase-order email that did not go.
--
-- WHY. The automatic send on order issue is failure isolated on purpose: when
-- the email fails the approval and the purchase order still commit, and the
-- person deciding sees a toast. That toast was the ONLY trace. The requester
-- who asked for the order to be emailed never learned it had not gone, and the
-- order card read only "Sent to supplier: Not yet", which is what it also says
-- when nobody ever tried.
--
-- Additive and idempotent: two nullable columns, no backfill, no default. Rows
-- written before this migration read as "no failed attempt recorded", which is
-- true of every one of them.
ALTER TABLE "Commitment" ADD COLUMN IF NOT EXISTS "lastSendAttemptAt" TIMESTAMP(3);
ALTER TABLE "Commitment" ADD COLUMN IF NOT EXISTS "lastSendError" TEXT;
