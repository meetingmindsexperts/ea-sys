-- Company (account) enrichment: a phone field + free-form tags, mirroring
-- CrmContact. Tags feed the account owner's own grouping + a list tag filter;
-- website already existed.
--
-- Additive + idempotent (safe on the shared prod DB, blue-green safe: old code
-- ignores the new columns). tags defaults to an empty array, phone is nullable,
-- so no backfill is needed and existing rows are unaffected.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
