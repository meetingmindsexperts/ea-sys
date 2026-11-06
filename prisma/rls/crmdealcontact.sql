-- Row-Level Security policy: CrmDealContact domain (CRM full-domain sweep, policy layer
-- — Group 2 / deal graph, July 2026). Byte-shape copy of prisma/rls/crmcontact.sql
-- (see contact.sql for the FULL rationale):
--   * applied ONLY by the tenant-isolation harness + the future PLATFORM
--     bootstrap. NEVER a prisma migration — master keeps ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId column (CrmDealContact carries a
--     direct organizationId).
--   * current_setting(..., true) → NULL when unset, so a missing tenant context
--     fail-closes to zero rows. The rls-assert.ts tripwire self-extends via
--     pg_policy.
-- organizationId is NOT NULL since Nov 6, 2026 (migration
-- 20261106140000_crm_junction_tenant_pinned), and the parent foreign keys are
-- composite on (id, organizationId), so a row's organisation always equals its
-- deal's: this flat predicate and the parent's agree by construction.
--
-- POLICY-ONLY pass: DB backstop (defence #2). The /api/crm/* handlers are not yet
-- runWithTenant-wrapped and by-id mutations not yet compound-where'd (C1/C2
-- follow-on). On master (flag off) this file is never applied.

ALTER TABLE "CrmDealContact" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmdealcontact_tenant_isolation ON "CrmDealContact";
CREATE POLICY crmdealcontact_tenant_isolation ON "CrmDealContact"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
