-- Row-Level Security policy: BillingAccount domain (Phase-2 sweep #3, July 2026).
--
-- Third domain to adopt the FLAT per-domain RLS template the Contacts pilot
-- ratified — and the first finance domain. BillingAccount carries a direct
-- organizationId column (the trivial case), so this is a flat policy. See
-- prisma/rls/contact.sql for the FULL rationale; this file follows it exactly:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap. NEVER a prisma migration — master keeps a DB
--     with zero RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId; current_setting(...,true)
--     fail-closes to zero rows when the GUC is unset.
--   * The rls-assert boot tripwire self-extends via pg_policy to cover it.
--
-- The route sweep for this domain is COMPLETE (unlike MediaFile's policy-only
-- pass): the service compound-where's its mutations + uses tenantTransaction
-- (commit C1), and all 8 handlers across the 5 billing routes wrap in
-- runWithTenant (commit C2). So on the platform this policy is the DB backstop
-- under a fully-wired app layer.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "BillingAccount" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billingaccount_tenant_isolation ON "BillingAccount";
CREATE POLICY billingaccount_tenant_isolation ON "BillingAccount"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
