-- Row-Level Security policy: RegistrationGroup (group registrations, Aug 2026).
--
-- Born-compliant domain (built AFTER the Phase-2 sweep completed): the table
-- carries a denormalized nullable organizationId stamped from the Event at
-- create by its ONE writer (group-registration-service), so this is the FLAT
-- per-domain template the Contacts pilot ratified. See prisma/rls/contact.sql
-- for the full rationale; this file follows it exactly:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap. NEVER a prisma migration — master keeps a DB
--     with zero RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId; current_setting(...,true)
--     fail-closes to zero rows when the GUC is unset.
--   * The rls-assert boot tripwire self-extends via pg_policy to cover it.
--
-- The child money rows (Invoice.groupId / Payment.groupId) are covered by
-- their own domain policies (invoice.sql / registration.sql) — a group
-- invoice is still an Invoice row with its own organizationId.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "RegistrationGroup" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS registrationgroup_tenant_isolation ON "RegistrationGroup";
CREATE POLICY registrationgroup_tenant_isolation ON "RegistrationGroup"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
