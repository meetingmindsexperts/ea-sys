-- Per-person HR access (owner, Aug 31 2026).
--
-- Additive and idempotent. NO BACKFILL, deliberately: granting every current
-- ADMIN would reproduce exactly the situation this replaces, where HR access
-- followed from a role that exists for other reasons. It fails closed, so the
-- people who need HR are ticked once in Settings -> Users after this deploys.
--
-- Blue/green safe: the old container never selects this column, and the new one
-- reads a value that already has a default.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "hrAccess" BOOLEAN NOT NULL DEFAULT false;
