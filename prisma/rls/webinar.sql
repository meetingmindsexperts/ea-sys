-- Row-Level Security policies: Webinar/Zoom domain (Phase-2 sweep #6, July 2026).
--
-- First MULTI-TABLE domain policy file, and the first whose tables did NOT
-- originally carry organizationId — migration 20260728140000 denormalized the
-- tenant key onto all 6 (backfilled from Event), so the ratified FLAT template
-- applies unchanged (columns were preferred over join-based policies, per
-- MULTI_TENANCY_IMPACT.md §8.2). See prisma/rls/contact.sql for the FULL
-- rationale; this file follows it exactly:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap. NEVER a prisma migration — master keeps a DB
--     with zero RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement is the non-owner app role.
--   * FLAT policy on the row's own organizationId; current_setting(...,true)
--     fail-closes to zero rows when the GUC is unset. A NULL organizationId
--     (pre-sweep blue-green-window row) also fail-closes — the sync state
--     machines self-heal the stamp on their next tick.
--   * The rls-assert boot tripwire self-extends via pg_policy to cover all 6.
--
-- App-layer wiring (defence #1): writers stamp organizationId + the zoom
-- session route binds session→event (commit C1); webinar routes + MCP
-- executors + the per-row worker sync fns wrap in runWithTenant (commit C2).
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "ZoomMeeting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zoommeeting_tenant_isolation ON "ZoomMeeting";
CREATE POLICY zoommeeting_tenant_isolation ON "ZoomMeeting"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ZoomAttendance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zoomattendance_tenant_isolation ON "ZoomAttendance";
CREATE POLICY zoomattendance_tenant_isolation ON "ZoomAttendance"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "WebinarPresence" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinarpresence_tenant_isolation ON "WebinarPresence";
CREATE POLICY webinarpresence_tenant_isolation ON "WebinarPresence"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "WebinarPoll" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinarpoll_tenant_isolation ON "WebinarPoll";
CREATE POLICY webinarpoll_tenant_isolation ON "WebinarPoll"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "WebinarPollResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinarpollresponse_tenant_isolation ON "WebinarPollResponse";
CREATE POLICY webinarpollresponse_tenant_isolation ON "WebinarPollResponse"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "WebinarQuestion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinarquestion_tenant_isolation ON "WebinarQuestion";
CREATE POLICY webinarquestion_tenant_isolation ON "WebinarQuestion"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
