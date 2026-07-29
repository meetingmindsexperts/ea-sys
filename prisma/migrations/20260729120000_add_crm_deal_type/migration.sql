-- Admin-editable CRM deal TYPE — the org-configurable business-line list
-- ("Conference Management", "Sponsorship Inquiry", …) shown as a dropdown on the
-- deal and managed in Settings. Same managed-list shape as CrmPipelineStage.
--
-- Additive + idempotent (safe on the shared prod DB, blue-green safe: old code
-- ignores the new table + column). CrmDeal.dealTypeId is nullable + SetNull, so
-- no backfill and removing a type never blocks a deal delete.

CREATE TABLE IF NOT EXISTS "CrmDealType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDealType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealType_organizationId_name_key" ON "CrmDealType"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "CrmDealType_organizationId_sortOrder_idx" ON "CrmDealType"("organizationId", "sortOrder");

ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "dealTypeId" TEXT;

DO $$ BEGIN
  ALTER TABLE "CrmDealType" ADD CONSTRAINT "CrmDealType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_dealTypeId_fkey" FOREIGN KEY ("dealTypeId") REFERENCES "CrmDealType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
