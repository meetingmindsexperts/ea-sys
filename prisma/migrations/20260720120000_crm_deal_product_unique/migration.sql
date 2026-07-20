-- CRM review R2 (July 20, 2026) — H2. Additive + idempotent.
--
-- CrmDealProduct had NO unique on (dealId, crmProductId), so the
-- PRODUCT_ALREADY_ON_DEAL guard in addDealProduct was check-then-act only:
-- two concurrent adds of the same catalog product (two reps with the deal
-- open, or a fast double-click) both passed the findFirst and created
-- duplicate line items — a double-counted products total and an ambiguous
-- target for the inline qty edit. Same class as the stage/template seed
-- races fixed in 20260716140000: a check without a UNIQUE constraint behind
-- it guards nothing under concurrency.
--
-- Keep-oldest dedup first (duplicates can only exist on a dev DB that raced
-- the old check — the CRM migrations are not on prod), then the unique.
-- Rows whose catalog product was deleted (crmProductId NULL via SetNull) are
-- exempt: Postgres unique indexes treat NULLs as distinct, so multiple such
-- legacy lines per deal stay legal.

DELETE FROM "CrmDealProduct" dup
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "dealId", "crmProductId" ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "CrmDealProduct"
  WHERE "crmProductId" IS NOT NULL
) ranked
WHERE dup.id = ranked.id AND ranked.rn > 1;

-- Name must match Prisma's default mapping for @@unique([dealId, crmProductId]).
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealProduct_dealId_crmProductId_key"
  ON "CrmDealProduct"("dealId", "crmProductId");

-- The unique's leftmost column now covers dealId lookups; the standalone index
-- is redundant (matches the schema, where @@index([dealId]) was removed).
DROP INDEX IF EXISTS "CrmDealProduct_dealId_idx";
