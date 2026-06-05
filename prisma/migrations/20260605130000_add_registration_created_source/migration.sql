-- Add provenance tracking to Registration: which code path created
-- the row?
--
-- Two additive changes — every existing Registration row defaults to
-- NULL on the new column, so this is deploy-safe alongside the
-- running web + worker containers:
--
--   1. New enum RegistrationCreatedSource with 7 values covering
--      every entry path (PUBLIC_REGISTER, PUBLIC_SUBMITTER,
--      PUBLIC_COMPLETION_FORM, ADMIN_DASHBOARD, CSV_IMPORT,
--      MCP_AGENT, OTHER).
--   2. Registration.createdSource  RegistrationCreatedSource?  —
--      set by every creation path going forward. NULL on historical
--      rows; the detail-sheet UI renders "Unknown" for those.
--
-- No backfill — the historical NULLs are intentional. An organizer
-- looking at a 6-month-old registration doesn't need provenance.

CREATE TYPE "RegistrationCreatedSource" AS ENUM (
  'PUBLIC_REGISTER',
  'PUBLIC_SUBMITTER',
  'PUBLIC_COMPLETION_FORM',
  'ADMIN_DASHBOARD',
  'CSV_IMPORT',
  'MCP_AGENT',
  'OTHER'
);

ALTER TABLE "Registration"
  ADD COLUMN "createdSource" "RegistrationCreatedSource";
