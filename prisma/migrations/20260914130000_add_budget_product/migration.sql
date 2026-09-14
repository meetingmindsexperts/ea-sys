-- Budget & Procurement: the product catalogue a budget line is picked from (Sep 14, 2026, owner request).
-- ADDITIVE AND IDEMPOTENT: one new table, one nullable column on "BudgetLine".
-- Nothing is renamed or dropped, so the still-live old container is never
-- surprised, and every statement is IF NOT EXISTS or DO-guarded so a re-run is
-- a no-op. Dark behind PROCUREMENT_MODULE_ENABLED like the rest of the module;
-- the table carries organizationId and an RLS policy in prisma/rls/procurement.sql.
CREATE TABLE IF NOT EXISTS "BudgetProduct" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetProduct_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetProduct_organizationId_sku_key" ON "BudgetProduct"("organizationId", "sku");
CREATE INDEX IF NOT EXISTS "BudgetProduct_organizationId_isActive_idx" ON "BudgetProduct"("organizationId", "isActive");
CREATE INDEX IF NOT EXISTS "BudgetProduct_categoryId_idx" ON "BudgetProduct"("categoryId");
DO $$ BEGIN
  ALTER TABLE "BudgetProduct" ADD CONSTRAINT "BudgetProduct_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetProduct" ADD CONSTRAINT "BudgetProduct_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "BudgetLine" ADD COLUMN IF NOT EXISTS "productId" TEXT;
CREATE INDEX IF NOT EXISTS "BudgetLine_productId_idx" ON "BudgetLine"("productId");
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "BudgetProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
