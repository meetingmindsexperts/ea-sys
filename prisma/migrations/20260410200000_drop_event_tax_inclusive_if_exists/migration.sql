-- Idempotent drop. Quotes/invoices/receipts always render the
-- subtotal + VAT + total breakdown, so we don't need a per-event toggle for
-- tax-inclusive vs tax-exclusive display. Safe on fresh databases that never
-- had the column (IF EXISTS) and on dev databases that briefly had it.
ALTER TABLE "Event" DROP COLUMN IF EXISTS "taxInclusive";
