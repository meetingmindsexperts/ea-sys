-- CRM contact enrichment — status (sales conversation), mobile, tags.
--
-- Additive + idempotent: a new enum, three nullable/defaulted columns, nothing
-- altered or dropped — blue-green safe (the old container never selects them).
-- The contact score is deliberately NOT a column: it is computed on read from
-- deal involvement, so it can never go stale.

DO $$ BEGIN
  CREATE TYPE "CrmContactStatus" AS ENUM
    ('NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST', 'UNQUALIFIED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "status" "CrmContactStatus";
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "mobile" TEXT;
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
