-- Which member registrations a GROUP invoice bills.
--
-- Additive + idempotent. Empty array (the default, and what every existing
-- row gets) means "every non-cancelled member of the group" — byte-identical
-- to the behaviour before this column, so no backfill is required and a
-- blue-green window where the old container is still serving is safe.
ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "coveredRegistrationIds" TEXT[] NOT NULL DEFAULT '{}';
