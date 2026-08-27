-- Row-Level Security policy: HR module, LeaveGrant (Aug 27, 2026).
-- Identical in shape and intent to prisma/rls/employee.sql, which carries the
-- full rationale (harness-applied only, no FORCE, flat organizationId, and why a
-- master-silo-only module is policied anyway).

ALTER TABLE "LeaveGrant" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leavegrant_tenant_isolation ON "LeaveGrant";
CREATE POLICY leavegrant_tenant_isolation ON "LeaveGrant"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
