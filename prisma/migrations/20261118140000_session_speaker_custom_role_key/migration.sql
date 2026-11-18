-- Session roles an organisation can edit (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md).
-- A role the organisation added (a Host that runs a session, a Keynote that
-- presents) is kept in Organization.settings.sessionRoles; an assignment holding
-- one stores its key here. NULL is a built-in, read from "role" as before.
--
-- "role" (the SessionRole enum) is still written on every assignment: for an
-- added role it holds the built-in of its duty (MODERATOR runs, SPEAKER
-- presents). So an image from before this migration, during a blue-green deploy
-- or after a rollback, still reads a valid role with the right duty: a Host
-- shows as "Moderator" and still gets the moderation run-sheet.
--
-- Additive + idempotent: one nullable column, no default, a catalogue change only.

SET lock_timeout = '10s';

ALTER TABLE "SessionSpeaker" ADD COLUMN IF NOT EXISTS "customRoleKey" TEXT;
