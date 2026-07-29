-- Row-Level Security policy: CrmDealType domain (CRM full-domain sweep, policy
-- layer — the deal-type list model added July 29). Follows prisma/rls/crmcontact.sql
-- byte-for-byte in shape and intent (see contact.sql for the FULL rationale):
--   * applied ONLY by the tenant-isolation harness (tests/tenancy/global-setup.ts
--     reads every prisma/rls/*.sql) + the future PLATFORM bootstrap. NEVER a
--     prisma migration — master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: same split).
--   * FLAT policy on the row's own organizationId column (CrmDealType carries a
--     direct organizationId — the trivial case).
--   * current_setting(..., true) returns NULL (not an error) when the GUC is
--     unset, so a missing tenant context fail-closes to zero rows.
--   * The rls-assert.ts boot tripwire self-extends over every policied table via
--     pg_policy, so it already covers CrmDealType with no code change.
--
-- POLICY-ONLY pass: the DB backstop (defence #2). The /api/crm/deal-types handlers
-- are not yet runWithTenant-wrapped, but the service already compound-where's every
-- by-id mutation { id, organizationId } (defence #1). On master (flag off) this
-- file is never applied.

ALTER TABLE "CrmDealType" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmdealtype_tenant_isolation ON "CrmDealType";
CREATE POLICY crmdealtype_tenant_isolation ON "CrmDealType"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
