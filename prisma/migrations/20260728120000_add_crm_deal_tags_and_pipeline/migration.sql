-- Add tags + pipeline category to CrmDeal.
--
-- Additive + idempotent (safe on the shared prod DB, blue-green safe: old code
-- ignores the new columns). `tags` mirrors CrmContact.tags; `pipeline` is a
-- simple deal category (Corporate / Conference), NOT a separate pipeline.

DO $$ BEGIN
  CREATE TYPE "CrmDealPipeline" AS ENUM ('CORPORATE', 'CONFERENCE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "pipeline" "CrmDealPipeline";
ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
