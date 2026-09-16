-- Row-Level Security: custom roles (docs/PROCUREMENT_ROLES_PLAN.md §5).
--
-- Born tenancy-compliant, in the same change as the tables: a role that says
-- who may approve money is exactly the shape that must never be readable or
-- writable across tenants, and retrofitting it later means a backfill.
--
-- Follows prisma/rls/contact.sql byte-for-byte in shape and intent:
--   * applied ONLY by the tenant-isolation harness (tests/tenancy/global-setup.ts
--     reads every prisma/rls/*.sql) and the future PLATFORM bootstrap. NEVER a
--     prisma migration; master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY: enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: the same split).
--   * FLAT policy on each row's own organizationId. All three tables carry one
--     directly, including the two children, so a cross-tenant read addressed by
--     a parent id misses rather than resolving through a join.
--   * current_setting(..., true) yields NULL when the GUC is unset, so a missing
--     tenant context fail-closes to zero rows.
--
-- WHY THE CHILDREN CARRY THEIR OWN COLUMN rather than relying on the parent.
-- `PermissionSetGrant` is the row that says "this role may approve", and
-- `UserPermissionSet` is the row that says "this person holds it". Both are
-- read on the authentication path, where the cheapest correct query is a flat
-- one; a join-based policy would also make a mis-scoped read look empty rather
-- than refused.
--
-- FAIL-CLOSED CONSEQUENCE WORTH KNOWING: under RLS, a permission read outside a
-- tenant lane returns zero rows, which reads as "this person holds no custom
-- role" rather than as an error. That is the safe direction, and it is why the
-- session plumbing borrows the lane from the user row rather than running the
-- read unwrapped.
--
-- Idempotent: safe to re-run. DROP+CREATE run as separate autocommit statements,
-- so a re-apply on a LIVE database has a brief RLS-enabled-with-no-policy
-- window, which is default-DENY, never a leak.
--
-- FOR ALL TO PUBLIC is written out explicitly (it IS the default) so a future
-- copy cannot accidentally narrow to FOR SELECT and lose write enforcement.

ALTER TABLE "PermissionSet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permissionset_tenant_isolation ON "PermissionSet";
CREATE POLICY permissionset_tenant_isolation ON "PermissionSet"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PermissionSetGrant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permissionsetgrant_tenant_isolation ON "PermissionSetGrant";
CREATE POLICY permissionsetgrant_tenant_isolation ON "PermissionSetGrant"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "UserPermissionSet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS userpermissionset_tenant_isolation ON "UserPermissionSet";
CREATE POLICY userpermissionset_tenant_isolation ON "UserPermissionSet"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
