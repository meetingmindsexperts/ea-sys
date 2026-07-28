-- Row-Level Security policy: CrmDealProduct domain (CRM full-domain sweep, policy layer
-- — Group 2 / deal graph, July 2026). Byte-shape copy of prisma/rls/crmcontact.sql
-- (see contact.sql for the FULL rationale):
--   * applied ONLY by the tenant-isolation harness + the future PLATFORM
--     bootstrap. NEVER a prisma migration — master keeps ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId column (CrmDealProduct carries a
--     direct organizationId).
--   * current_setting(..., true) → NULL when unset, so a missing tenant context
--     fail-closes to zero rows. The rls-assert.ts tripwire self-extends via
--     pg_policy.\n-- NOTE: organizationId is NULLABLE here (blue-green junction prep) — the flat\n-- predicate excludes a NULL-org row (invisible), which is correct: the app\n-- always writes the org, and the platform silo tightens it to NOT NULL.
--
-- POLICY-ONLY pass: DB backstop (defence #2). The /api/crm/* handlers are not yet
-- runWithTenant-wrapped and by-id mutations not yet compound-where'd (C1/C2
-- follow-on). On master (flag off) this file is never applied.

ALTER TABLE "CrmDealProduct" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmdealproduct_tenant_isolation ON "CrmDealProduct";
CREATE POLICY crmdealproduct_tenant_isolation ON "CrmDealProduct"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
