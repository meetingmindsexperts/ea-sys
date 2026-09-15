-- Budget & Procurement, Phase 2 slice 3: purchase orders (Sep 15, 2026).
-- Spec docs/BUDGET_PROCUREMENT_MODULE.html §5, §6; plan docs/BUDGET_PROCUREMENT_BUILD_PLAN.md §6.
--
-- ADDITIVE AND IDEMPOTENT: five nullable-or-defaulted columns, no table, no
-- index. The still-live old container never reads them, so the blue-green
-- window is safe in both directions.
--
-- emailSupplierOnIssue: the requester's per-request choice to email the PO
-- PDF to the supplier when the order is issued (owner decision, 15 Sep 2026:
-- a checkbox, default off, with a manual Send button either way).
ALTER TABLE "SpendRequest" ADD COLUMN IF NOT EXISTS "emailSupplierOnIssue" BOOLEAN NOT NULL DEFAULT false;

-- The quote document itself, under the private procurement-quotes prefix.
ALTER TABLE "SpendRequestQuote" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT;
ALTER TABLE "SpendRequestQuote" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "SpendRequestQuote" ADD COLUMN IF NOT EXISTS "fileMimeType" TEXT;
ALTER TABLE "SpendRequestQuote" ADD COLUMN IF NOT EXISTS "fileSize" INTEGER;
