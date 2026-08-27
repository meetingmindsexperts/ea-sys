-- Row-Level Security policy: HR module, PublicHoliday (Aug 27, 2026).
-- Identical in shape and intent to prisma/rls/employee.sql, which carries the
-- full rationale (harness-applied only, no FORCE, flat organizationId, and why a
-- master-silo-only module is policied anyway).

ALTER TABLE "PublicHoliday" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS publicholiday_tenant_isolation ON "PublicHoliday";
CREATE POLICY publicholiday_tenant_isolation ON "PublicHoliday"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
