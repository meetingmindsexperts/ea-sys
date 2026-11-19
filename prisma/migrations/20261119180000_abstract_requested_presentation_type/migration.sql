-- The presentation type the AUTHOR asked for, kept beside the organiser's
-- decision (owner, Nov 19, 2026: "we need it for records").
--
-- Until now an abstract had one type column. The author picks it on the
-- submission form, and an organiser setting the type (Bulk set type, Set
-- status with a type, the edit page) wrote over it, so the author's choice
-- was lost. "presentationType" stays the decision; this column is the request,
-- written at submission and by the author's own edits only
-- (src/lib/abstract-requested-type.ts).
--
-- THE FILL copies today's type. Checked on production the same day: of 172
-- abstracts, no organiser had yet changed a type (the one recorded bulk change
-- set POSTER to POSTER), so every current value is the author's own; one
-- abstract has a later staff edit that recorded no old value, and its type
-- matches the one it was created with.
--
-- ADDITIVE AND IDEMPOTENT. One nullable column with no default, so no table
-- rewrite. The fill touches only rows where the column is empty and leaves
-- "updatedAt" alone (the edit page's stale-write check reads it). An older
-- image never reads or writes the column; a row it writes during the swap is
-- filled from its type the first time an organiser changes that type. A re-run
-- is a no-op.

SET lock_timeout = '10s';

ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "requestedPresentationType" "PresentationType";

UPDATE "Abstract"
SET "requestedPresentationType" = "presentationType"
WHERE "requestedPresentationType" IS NULL
  AND "presentationType" IS NOT NULL;
