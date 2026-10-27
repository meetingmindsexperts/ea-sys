-- CRM accounts get an owner (Oct 27, 2026): Freshsales' "Sales owner".
--
-- Additive and idempotent: one nullable column, its index and its foreign key,
-- every statement guarded so a re-run is a no-op. Nothing existing changes, so
-- the container still running the previous image keeps working against it.
-- ON DELETE SET NULL: deleting a user leaves the account unowned, never blocked.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;

CREATE INDEX IF NOT EXISTS "CrmCompany_ownerId_idx" ON "CrmCompany"("ownerId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmCompany_ownerId_fkey') THEN
    ALTER TABLE "CrmCompany"
      ADD CONSTRAINT "CrmCompany_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
