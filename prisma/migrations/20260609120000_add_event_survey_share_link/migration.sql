-- Add organizer-generated shareable survey link.
--
-- Single additive change — every existing event row defaults to NULL,
-- so this is deploy-safe alongside the running web + worker containers
-- (neither references the column until this code ships). Mirrors the
-- Event.surveyConfig additive pattern in 20260605120000_add_survey.
--
--   Event.surveyShareLink  JSON?  — `{ token, expiresAt, createdAt,
--     createdByUserId }` or NULL. Plaintext token (re-displayable URL,
--     like Abstract.managementToken). Lookup is slug-scoped, so no
--     index is required.

ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "surveyShareLink" JSONB;
