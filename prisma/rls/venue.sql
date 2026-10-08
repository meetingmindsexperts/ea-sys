-- RLS for the online venue tables (Oct 8, 2026; docs/EVENT_BLUEPRINT_PLAN.md).
-- Born tenant-correct: organizationId is stamped from the Event at write and
-- every route runs inside runWithTenant. Flat policy.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "VenueActivity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venueactivity_tenant_isolation ON "VenueActivity";
CREATE POLICY venueactivity_tenant_isolation ON "VenueActivity"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "VenueReport" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venuereport_tenant_isolation ON "VenueReport";
CREATE POLICY venuereport_tenant_isolation ON "VenueReport"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "VenueAiUsage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venueaiusage_tenant_isolation ON "VenueAiUsage";
CREATE POLICY venueaiusage_tenant_isolation ON "VenueAiUsage"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
