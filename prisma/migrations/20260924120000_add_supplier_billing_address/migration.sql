-- Supplier billing address, switchboard and accounts inbox (24 September 2026).
-- Additive and idempotent: seven nullable text columns, no default, no backfill,
-- no index. Safe for blue/green: the old container never reads them, and a
-- re-run is a no-op.
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "billingLine1" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "billingLine2" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "billingCity" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "billingRegion" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "billingPostalCode" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "accountsEmail" TEXT;
