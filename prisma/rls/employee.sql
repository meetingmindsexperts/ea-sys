-- Row-Level Security policy: HR module, Employee (Aug 27, 2026).
-- The other four HR tables (leavecode, attendanceentry, leavegrant,
-- publicholiday) follow this file byte-for-byte in shape; see contact.sql for
-- the FULL project-wide rationale.
--
--   * applied ONLY by the tenant-isolation harness (tests/tenancy/global-setup.ts
--     reads every prisma/rls/*.sql) + the PLATFORM bootstrap. NEVER a prisma
--     migration: master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY: enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: the same split), which is
--     also what leaves the dbOperator maintenance lane able to work.
--   * FLAT policy on the row's own organizationId (a direct column: the trivial
--     case). Every HR table carries one, deliberately, even though the module is
--     master-silo only.
--   * current_setting(..., true) returns NULL rather than erroring when the GUC
--     is unset, so a missing tenant context fail-closes to zero rows.
--
-- WHY POLICY A MODULE THAT ONLY RUNS ON MASTER. Availability and tenancy are
-- different questions (docs/HR_MODULE_PLAN.md §2a). The module is gated OFF on
-- the platform by HR_MODULE_ENABLED, but the tables ship in the shared migration
-- chain, so they EXIST there regardless. An existing unpoliced table is a latent
-- hole the day somebody flips the flag, and "we will add the policy when we
-- enable it" is precisely the sentence that does not survive a year. The policy
-- costs nothing while the module is off and is already correct when it is not.
--
-- The rls-assert.ts boot tripwire self-extends over every policied table via
-- pg_policy, so it covers these with no code change.

ALTER TABLE "Employee" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_tenant_isolation ON "Employee";
CREATE POLICY employee_tenant_isolation ON "Employee"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
