-- Budget & Procurement, revenue (spec §6b, 17 September 2026): planned revenue
-- lines per income account, the planned revenue total and the target margin
-- on a budget version.
--
-- Purely ADDITIVE and IDEMPOTENT: one new table, two new columns (one with a
-- default, one nullable), nothing renamed or dropped, no existing row changed.
-- Blue-green safe: the container on the previous image never reads the table
-- and ignores the columns. The income-account categories are seeded by the
-- application's seed-once service, not here, so the list lives in one place.

ALTER TABLE "EventBudget" ADD COLUMN IF NOT EXISTS "plannedRevenueTotal" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "EventBudget" ADD COLUMN IF NOT EXISTS "targetMarginPercent" DECIMAL(5,2);

CREATE TABLE IF NOT EXISTS "BudgetRevenueLine" (
  "id"                  TEXT          NOT NULL,
  "organizationId"      TEXT          NOT NULL,
  "budgetId"            TEXT          NOT NULL,
  "lineKey"             TEXT          NOT NULL,
  "categoryId"          TEXT          NOT NULL,
  "description"         TEXT          NOT NULL,
  "qty"                 DECIMAL(14,4) NOT NULL DEFAULT 1,
  "unitAmount"          DECIMAL(18,4) NOT NULL DEFAULT 0,
  "transactionCurrency" TEXT          NOT NULL,
  "fxRateToReporting"   DECIMAL(18,8) NOT NULL DEFAULT 1,
  "fxRateSource"        TEXT          NOT NULL DEFAULT 'same-currency',
  "fxRateAsOf"          TIMESTAMP(3),
  "planned"             DECIMAL(18,4) NOT NULL DEFAULT 0,
  "notes"               TEXT,
  "sortOrder"           INTEGER       NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "BudgetRevenueLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BudgetRevenueLine_budgetId_lineKey_key"    ON "BudgetRevenueLine"("budgetId", "lineKey");
CREATE INDEX        IF NOT EXISTS "BudgetRevenueLine_organizationId_idx"      ON "BudgetRevenueLine"("organizationId");
CREATE INDEX        IF NOT EXISTS "BudgetRevenueLine_budgetId_categoryId_idx" ON "BudgetRevenueLine"("budgetId", "categoryId");

-- Foreign keys, each guarded so a re-run is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetRevenueLine_organizationId_fkey') THEN
    ALTER TABLE "BudgetRevenueLine" ADD CONSTRAINT "BudgetRevenueLine_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetRevenueLine_budgetId_fkey') THEN
    ALTER TABLE "BudgetRevenueLine" ADD CONSTRAINT "BudgetRevenueLine_budgetId_fkey"
      FOREIGN KEY ("budgetId") REFERENCES "EventBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetRevenueLine_categoryId_fkey') THEN
    ALTER TABLE "BudgetRevenueLine" ADD CONSTRAINT "BudgetRevenueLine_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
