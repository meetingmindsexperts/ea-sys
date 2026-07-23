-- Multi-tenant prep: the two CRM junction tables were the only Crm* models
-- without organizationId. Safe today (every lookup binds through the org-scoped
-- parent deal), but a future RLS policy on the platform silo needs a cheap
-- single-column predicate. Nullable for blue-green safety (an old container
-- mid-swap still inserts without it); backfilled here from the parent deal;
-- the app writes it on every create from this deploy on.
-- Additive + idempotent.

ALTER TABLE "CrmDealProduct" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "CrmDealContact" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- Backfill existing rows from the parent deal (idempotent — only fills NULLs).
UPDATE "CrmDealProduct" p
SET "organizationId" = d."organizationId"
FROM "CrmDeal" d
WHERE p."dealId" = d."id" AND p."organizationId" IS NULL;

UPDATE "CrmDealContact" c
SET "organizationId" = d."organizationId"
FROM "CrmDeal" d
WHERE c."dealId" = d."id" AND c."organizationId" IS NULL;

CREATE INDEX IF NOT EXISTS "CrmDealProduct_organizationId_idx" ON "CrmDealProduct"("organizationId");
CREATE INDEX IF NOT EXISTS "CrmDealContact_organizationId_idx" ON "CrmDealContact"("organizationId");
