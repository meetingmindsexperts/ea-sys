-- Row-Level Security policy: HR module, AttendanceEntry (Aug 27, 2026).
-- Identical in shape and intent to prisma/rls/employee.sql, which carries the
-- full rationale (harness-applied only, no FORCE, flat organizationId, and why a
-- master-silo-only module is policied anyway).

ALTER TABLE "AttendanceEntry" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendanceentry_tenant_isolation ON "AttendanceEntry";
CREATE POLICY attendanceentry_tenant_isolation ON "AttendanceEntry"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
