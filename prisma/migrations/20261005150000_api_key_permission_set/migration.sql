-- Custom roles Phase 5: an API key may act with a role (plan §8.1).
--
-- Today every key is the full "API key" system role, admin-equivalent. A
-- nullable column keeps every existing key exactly as it is (null = full);
-- an admin narrows a key by choosing a role, and the key then does only what
-- that role grants, on REST and MCP alike.
--
-- FULLY ADDITIVE AND IDEMPOTENT: one nullable column, one index, one foreign
-- key; nothing existing changes. RESTRICT on delete: emptying the column
-- would silently widen the key back to full, so a role a key uses cannot be
-- deleted (roles are archived, and an archived role grants a key nothing).

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "permissionSetId" TEXT;

CREATE INDEX IF NOT EXISTS "ApiKey_permissionSetId_idx" ON "ApiKey"("permissionSetId");

DO $$ BEGIN
  ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_permissionSetId_fkey"
    FOREIGN KEY ("permissionSetId") REFERENCES "PermissionSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
