-- Row-Level Security policy: CrmDealDocument domain (CRM full-domain sweep, policy layer
-- — Group 2 / deal graph, July 2026). Byte-shape copy of prisma/rls/crmcontact.sql
-- (see contact.sql for the FULL rationale):
--   * applied ONLY by the tenant-isolation harness + the future PLATFORM
--     bootstrap. NEVER a prisma migration — master keeps ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId column (CrmDealDocument carries a
--     direct organizationId).
--   * current_setting(..., true) → NULL when unset, so a missing tenant context
--     fail-closes to zero rows. The rls-assert.ts tripwire self-extends via
--     pg_policy.
--
-- POLICY-ONLY pass: DB backstop (defence #2). The /api/crm/* handlers are not yet
-- runWithTenant-wrapped and by-id mutations not yet compound-where'd (C1/C2
-- follow-on). On master (flag off) this file is never applied.

ALTER TABLE "CrmDealDocument" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmdealdocument_tenant_isolation ON "CrmDealDocument";
CREATE POLICY crmdealdocument_tenant_isolation ON "CrmDealDocument"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
