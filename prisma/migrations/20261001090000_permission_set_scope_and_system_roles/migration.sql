-- Custom roles Phase 1 slice 2 (Oct 1, 2026): a scope on each grant, and the
-- system roles as rows (docs/CUSTOM_ROLES_PLAN.md §3.3). Additive and
-- idempotent: one enum, three nullable-or-defaulted columns, one unique index.
-- Nothing existing is touched, and nothing reads the new columns until the
-- Phase 2 route sweep, so old and new code run side by side.

DO $$ BEGIN
  CREATE TYPE "GrantScope" AS ENUM ('ALL', 'ASSIGNED', 'WEBINAR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "PermissionSet" ADD COLUMN IF NOT EXISTS "key" TEXT;
ALTER TABLE "PermissionSet" ADD COLUMN IF NOT EXISTS "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- Postgres treats NULLs as distinct in a unique index, so every custom role
-- (key NULL) coexists; only the system keys are unique per organisation.
CREATE UNIQUE INDEX IF NOT EXISTS "PermissionSet_organizationId_key_key" ON "PermissionSet"("organizationId", "key");

ALTER TABLE "PermissionSetGrant" ADD COLUMN IF NOT EXISTS "scope" "GrantScope";
