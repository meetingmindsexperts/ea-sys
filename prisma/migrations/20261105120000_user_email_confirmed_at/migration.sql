-- Account confirmation (Nov 5, 2026; docs/ACCOUNT_CONFIRMATION_PLAN.md).
-- Additive and idempotent: one nullable column, nothing existing changed, no
-- backfill (no existing account has proven its address through this column).
-- No rollback hazard: an older image never reads it.
--
--   User.emailConfirmedAt  set only by a link sent to the address

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailConfirmedAt" TIMESTAMP(3);
