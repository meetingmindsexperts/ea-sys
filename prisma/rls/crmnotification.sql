-- Row-Level Security policy: CrmNotification domain (CRM full-domain sweep, policy layer
-- — Group 1, July 2026). Follows prisma/rls/crmcontact.sql byte-for-byte in shape
-- and intent (see contact.sql for the FULL rationale):
--   * applied ONLY by the tenant-isolation harness (tests/tenancy/global-setup.ts
--     reads every prisma/rls/*.sql) + the future PLATFORM bootstrap. NEVER a
--     prisma migration — master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: same split).
--   * FLAT policy on the row's own organizationId column (CrmNotification carries a
--     direct organizationId — the trivial case).
--   * current_setting(..., true) returns NULL (not an error) when the GUC is
--     unset, so a missing tenant context fail-closes to zero rows.
--   * The rls-assert.ts boot tripwire self-extends over every policied table via
--     pg_policy, so it already covers CrmNotification with no code change.
--
-- POLICY-ONLY pass: the DB backstop (defence #2). The /api/crm/* handlers are not
-- yet runWithTenant-wrapped and the by-id mutations are not yet compound-where'd
-- (C1/C2 app-wiring is the follow-on before the platform turns RLS_SET_LOCAL on).
-- On master (flag off) this file is never applied.

ALTER TABLE "CrmNotification" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmnotification_tenant_isolation ON "CrmNotification";
CREATE POLICY crmnotification_tenant_isolation ON "CrmNotification"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
