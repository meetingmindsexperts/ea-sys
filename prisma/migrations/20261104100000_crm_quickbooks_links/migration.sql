-- CRM quotes to QuickBooks Estimates (Nov 4, 2026): the links a send needs.
-- A sponsor company links to an existing QuickBooks customer, a catalogue
-- product to a QuickBooks product/service, and a quote records the Estimate it
-- became. Each link carries the QuickBooks company (realm) it was made in.
-- Additive and idempotent: nullable (or defaulted) columns and one unique index on existing
-- tables, no new table (so no RLS file). Rollback note: an older image never
-- reads these columns, so it also ignores the lock on a sent quote and would
-- let it be edited or deleted; roll back only with no quotes mid-send.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "qboCustomerId" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "qboCustomerName" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "qboCustomerCurrency" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "qboRealmId" TEXT;

ALTER TABLE "CrmProduct" ADD COLUMN IF NOT EXISTS "qboItemId" TEXT;
ALTER TABLE "CrmProduct" ADD COLUMN IF NOT EXISTS "qboItemName" TEXT;
ALTER TABLE "CrmProduct" ADD COLUMN IF NOT EXISTS "qboRealmId" TEXT;

ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboEstimateId" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboEstimateNumber" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboRealmId" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboEnvironment" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboSentAt" TIMESTAMP(3);
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboSentById" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboSentByName" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboSendStartedAt" TIMESTAMP(3);
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboLastError" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboSendAttempt" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "CrmQuote_qboRealmId_qboEstimateId_key" ON "CrmQuote"("qboRealmId", "qboEstimateId");
