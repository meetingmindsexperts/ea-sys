-- RegistrationCreatedSource.FACULTY_ADMIN (Nov 10, 2026): a registration added
-- as Faculty from the admin Add Registration form, typically a committee
-- member with no speaker record (owner: Faculty is the umbrella for invited
-- speakers and committee). Seatless, like SPEAKER_COMPANION.
-- Additive enum value: blue/green safe while no row carries it. Rollback
-- hazard: an image older than this migration cannot read a row that does
-- (docs/ROLLBACK.md). Idempotent: safe to re-run.

ALTER TYPE "RegistrationCreatedSource" ADD VALUE IF NOT EXISTS 'FACULTY_ADMIN';
