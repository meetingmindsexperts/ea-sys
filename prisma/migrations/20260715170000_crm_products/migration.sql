-- CRM product/service catalog + deal line items.
--
-- Additive + idempotent (INC-003 discipline): one new enum, two new tables. No
-- existing column dropped or made NOT NULL. The catalog is seeded lazily by the
-- service on first use; this migration only creates the structures.

DO $$ BEGIN
  CREATE TYPE "CrmProductSource" AS ENUM ('IN_HOUSE', 'OUTSOURCED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Catalog.
CREATE TABLE IF NOT EXISTS "CrmProduct" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "category" TEXT NOT NULL,
    "source" "CrmProductSource" NOT NULL DEFAULT 'IN_HOUSE',
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "priceIncludesTax" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmProduct_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmProduct_organizationId_category_sortOrder_idx"
    ON "CrmProduct" ("organizationId", "category", "sortOrder");

-- Deal line item.
CREATE TABLE IF NOT EXISTS "CrmDealProduct" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "crmProductId" TEXT,
    "productName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sku" TEXT,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmDealProduct_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmDealProduct_dealId_idx" ON "CrmDealProduct" ("dealId");
CREATE INDEX IF NOT EXISTS "CrmDealProduct_crmProductId_idx" ON "CrmDealProduct" ("crmProductId");

DO $$ BEGIN
  ALTER TABLE "CrmProduct" ADD CONSTRAINT "CrmProduct_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmProduct" ADD CONSTRAINT "CrmProduct_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmDealProduct" ADD CONSTRAINT "CrmDealProduct_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmDealProduct" ADD CONSTRAINT "CrmDealProduct_crmProductId_fkey"
    FOREIGN KEY ("crmProductId") REFERENCES "CrmProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
