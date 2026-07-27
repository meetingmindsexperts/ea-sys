-- Row-Level Security policy: Invoice domain (Phase-2 sweep #4, July 2026).
--
-- Fourth domain to adopt the FLAT per-domain RLS template the Contacts pilot
-- ratified, and the second finance domain (after BillingAccount). Invoice
-- carries a direct organizationId column (no backfill), so this is a flat
-- policy. See prisma/rls/contact.sql for the FULL rationale; this file follows
-- it exactly:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap. NEVER a prisma migration — master keeps a DB
--     with zero RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId; current_setting(...,true)
--     fail-closes to zero rows when the GUC is unset.
--   * The rls-assert boot tripwire self-extends via pg_policy to cover it.
--
-- The route sweep for this domain is COMPLETE (like BillingAccount): the
-- service compound-where's its by-id mutations + uses tenantTransaction for its
-- 4 interactive txns (commit C1); the 8 staff route handlers + the 4 MCP
-- executors wrap in runWithTenant (commit C2a); and the 6 cross-domain invoice
-- writers (Stripe webhook, reconciliation worker, manual payments, documents-
-- resend, public document, payment-service credit-note) wrap their invoice-
-- write block in runWithTenant (commit C2b). So on the platform this policy is
-- the DB backstop under a fully-wired app layer. (The 3 REGISTRANT invoice/
-- quote reader routes are deliberately deferred — cross-org REGISTRANTs have
-- organizationId=null and their resource-org binding is the open Phase-1
-- identity decision.)
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_tenant_isolation ON "Invoice";
CREATE POLICY invoice_tenant_isolation ON "Invoice"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
