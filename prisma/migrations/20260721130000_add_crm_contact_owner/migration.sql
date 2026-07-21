-- CRM contact owner — powers the "My contacts" filter.
--
-- Additive + idempotent: one nullable FK column + index, nothing altered or
-- dropped — blue-green safe. SetNull like CrmDeal.ownerId: deleting a user
-- leaves the contact unowned, never blocked or destroyed. Existing rows stay
-- unowned (no backfill — ownership is a human assignment, not a guess).

ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;

CREATE INDEX IF NOT EXISTS "CrmContact_ownerId_idx" ON "CrmContact" ("ownerId");

DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
