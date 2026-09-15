-- Row-Level Security policy: CrmQuote (CRM quote editor, Sep 15 2026). Same shape and
-- intent as crmquotecounter.sql (see contact.sql for the full rationale):
--   * applied ONLY by the tenant-isolation harness and the future PLATFORM
--     bootstrap. NEVER a prisma migration: master keeps a database with ZERO RLS
--     objects.
--   * NO FORCE ROW LEVEL SECURITY: enforcement comes from connecting as a
--     NON-owner app role.
--   * FLAT policy on the row's own organizationId column.
--   * current_setting(..., true) returns NULL when the GUC is unset, so a missing
--     tenant context fail-closes to zero rows.

ALTER TABLE "CrmQuote" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmquote_tenant_isolation ON "CrmQuote";
CREATE POLICY crmquote_tenant_isolation ON "CrmQuote"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
