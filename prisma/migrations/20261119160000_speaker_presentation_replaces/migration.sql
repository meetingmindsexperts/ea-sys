-- Speaker presentations: up to three files per talk (owner, Nov 19, 2026).
--
-- A talk held one file and every upload replaced it. Now an upload either
-- ADDS a file to the talk (slides and a separate video) or replaces ONE named
-- file. This column is which: the id of the file this upload replaces, set
-- when the upload starts and acted on when it is checked. NULL is an add.
--
-- ADDITIVE AND IDEMPOTENT. One nullable column, no constraint: an older
-- image never reads or writes it, so a blue/green swap is unaffected, and a
-- row it wrote meanwhile is simply an add. A re-run is a no-op.

SET lock_timeout = '10s';

ALTER TABLE "SpeakerPresentation" ADD COLUMN IF NOT EXISTS "replacesId" TEXT;
