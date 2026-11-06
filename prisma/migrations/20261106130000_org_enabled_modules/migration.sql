-- Per-organisation module entitlements (CRM product review P1-5, Nov 6, 2026).
-- Additive and idempotent. Every organisation that exists when this runs keeps
-- the CRM it already has; one created afterwards starts with no modules.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "enabledModules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Organization"
SET "enabledModules" = array_append("enabledModules", 'crm')
WHERE NOT ('crm' = ANY("enabledModules"));
