-- Add the CRM_USER role — an org-bound team role confined to the CRM module.
--
-- ADDITIVE + IDEMPOTENT. `ADD VALUE IF NOT EXISTS` is blue-green safe: the still-
-- running old container never encounters the value (no user holds it yet), and a
-- re-run is a no-op. This is the ONLY statement, so it isn't used in the same
-- transaction it's created in (a Postgres restriction on new enum values).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'CRM_USER';
