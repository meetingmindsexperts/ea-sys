-- Deactivate an internal user without deleting them.
--
-- Additive + idempotent + blue-green safe: nullable with no default, so the OLD
-- container (which does not select it) is unaffected and every existing row
-- reads as active. Nobody is deactivated by this deploy.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
