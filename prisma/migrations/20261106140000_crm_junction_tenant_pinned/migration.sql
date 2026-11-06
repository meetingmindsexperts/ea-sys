-- CRM junction tables pinned to their tenant (CRM product review P2-11, Nov 6, 2026).
-- CrmDealProduct and CrmDealContact: organizationId NOT NULL, and the parent
-- foreign keys become COMPOSITE (parentId, organizationId) → parent(id,
-- organizationId), so the database refuses a link across organisations.
-- Blue/green safe: every writer, including the image in production before
-- this deploy, already sets organizationId. Idempotent: safe to re-run.

-- 1. Backfill and repair from the parent deal (the deal's organisation is the truth).
UPDATE "CrmDealProduct" p SET "organizationId" = d."organizationId"
FROM "CrmDeal" d
WHERE d.id = p."dealId" AND (p."organizationId" IS NULL OR p."organizationId" <> d."organizationId");

UPDATE "CrmDealContact" c SET "organizationId" = d."organizationId"
FROM "CrmDeal" d
WHERE d.id = c."dealId" AND (c."organizationId" IS NULL OR c."organizationId" <> d."organizationId");

-- A deal-contact link whose contact belongs to another organisation is a
-- cross-tenant link the new key forbids; there should be none, and any found is
-- removed rather than silently re-pointed (the contact is not this deal's).
DELETE FROM "CrmDealContact" c
USING "CrmContact" k
WHERE k.id = c."crmContactId" AND k."organizationId" <> c."organizationId";

-- 2. NOT NULL.
ALTER TABLE "CrmDealProduct" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "CrmDealContact" ALTER COLUMN "organizationId" SET NOT NULL;

-- 3. The (id, organizationId) keys the composite foreign keys point at.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDeal_id_organizationId_key" ON "CrmDeal"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_id_organizationId_key" ON "CrmContact"("id", "organizationId");

-- 4. Swap the single-column foreign keys for the composite ones.
ALTER TABLE "CrmDealProduct" DROP CONSTRAINT IF EXISTS "CrmDealProduct_dealId_fkey";
ALTER TABLE "CrmDealContact" DROP CONSTRAINT IF EXISTS "CrmDealContact_dealId_fkey";
ALTER TABLE "CrmDealContact" DROP CONSTRAINT IF EXISTS "CrmDealContact_crmContactId_fkey";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmDealProduct_dealId_organizationId_fkey') THEN
    ALTER TABLE "CrmDealProduct" ADD CONSTRAINT "CrmDealProduct_dealId_organizationId_fkey"
      FOREIGN KEY ("dealId", "organizationId") REFERENCES "CrmDeal"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmDealContact_dealId_organizationId_fkey') THEN
    ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_dealId_organizationId_fkey"
      FOREIGN KEY ("dealId", "organizationId") REFERENCES "CrmDeal"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmDealContact_crmContactId_organizationId_fkey') THEN
    ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_crmContactId_organizationId_fkey"
      FOREIGN KEY ("crmContactId", "organizationId") REFERENCES "CrmContact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
