-- Row-Level Security policy: CrmProject (Nov 12, 2026).
--
-- Corporate projects: the CRM's list of work that is not an event. Same FLAT
-- per-domain template as every other Crm* table; see prisma/rls/contact.sql for
-- the full rationale and prisma/rls/crmcontact.sql for the CRM notes:
--   * applied ONLY by the tenant-isolation harness and the future PLATFORM
--     bootstrap. NEVER a prisma migration: master holds zero RLS objects.
--   * NO FORCE ROW LEVEL SECURITY: enforcement comes from connecting as a
--     non-owner app role.
--   * FLAT policy on the row's own organizationId column.
--   * current_setting(..., true) is NULL when the setting is absent, so a
--     missing tenant context fail-closes to zero rows.
--
-- Shipped with the table, so the platform instance never holds a CrmProject
-- row without a policy. The routes are wrapped in runWithTenant from day one.
--
-- Idempotent: safe to re-run.

ALTER TABLE "CrmProject" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmproject_tenant_isolation ON "CrmProject";
CREATE POLICY crmproject_tenant_isolation ON "CrmProject"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
