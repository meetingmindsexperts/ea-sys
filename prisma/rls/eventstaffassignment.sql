-- Row-level security for EventStaffAssignment (custom roles Phase 4).
--
-- Flat policy on organizationId, matching the other tenant tables. NO FORCE:
-- enforcement lives in the non-owner application role the tenancy harness and
-- the platform run as. Applied by the harness and the platform bootstrap,
-- never by a prisma migration, so master's database holds no RLS objects.
--
-- Fails closed: with app.current_org unset, current_setting(..., true) returns
-- NULL and the comparison matches nothing.

ALTER TABLE "EventStaffAssignment" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eventstaffassignment_tenant_isolation ON "EventStaffAssignment";
CREATE POLICY eventstaffassignment_tenant_isolation ON "EventStaffAssignment"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
