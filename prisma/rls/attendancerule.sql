-- Row-level security for AttendanceRule.
--
-- Flat policy on the denormalised organizationId, matching every other HR
-- table. NO FORCE: enforcement lives in the non-owner application role, which
-- is the two-role split the tenancy harness runs as and the platform's
-- reference architecture. Applied by the harness and the platform bootstrap,
-- never by a prisma migration, so master's database holds no RLS objects.
--
-- Fails closed: with app.current_org unset, current_setting(..., true) returns
-- NULL and the comparison matches nothing.

ALTER TABLE "AttendanceRule" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendancerule_tenant_isolation ON "AttendanceRule";
CREATE POLICY attendancerule_tenant_isolation ON "AttendanceRule"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
