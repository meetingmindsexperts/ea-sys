-- Row-Level Security policies: sessions/tracks domain (Phase-2 sweep, Domain #12,
-- July 2026) — Track, EventSession (1-hop from Event) + SessionTopic,
-- SessionSpeaker (2-hop via EventSession) + TopicSpeaker (3-hop via SessionTopic).
-- SessionSpeaker + TopicSpeaker are composite-PK join tables (no own id) with a
-- scalar denormalized organizationId. All 5 gained the column in migration
-- 20260731160000, backfilled from the owning Event in hop order.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * session-service owns most writes (createSession nested create + the
--     update/roster tenantTransactions); every nested child row (SessionSpeaker /
--     SessionTopic / TopicSpeaker) is org-stamped so WITH CHECK admits it.
--   * The session/track routes wrap with the RESOURCE org (event.organizationId
--     via buildEventAccessWhere / publicEventWhere) — they serve org-null
--     submitters (agenda view) as well as org staff.
--   * ZoomMeeting/ZoomAttendance/WebinarPresence (also hanging off EventSession)
--     are their OWN swept domain (Webinar sweep) — not re-policied here.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Track" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS track_tenant_isolation ON "Track";
CREATE POLICY track_tenant_isolation ON "Track"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "EventSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eventsession_tenant_isolation ON "EventSession";
CREATE POLICY eventsession_tenant_isolation ON "EventSession"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SessionTopic" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessiontopic_tenant_isolation ON "SessionTopic";
CREATE POLICY sessiontopic_tenant_isolation ON "SessionTopic"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SessionSpeaker" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessionspeaker_tenant_isolation ON "SessionSpeaker";
CREATE POLICY sessionspeaker_tenant_isolation ON "SessionSpeaker"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "TopicSpeaker" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topicspeaker_tenant_isolation ON "TopicSpeaker";
CREATE POLICY topicspeaker_tenant_isolation ON "TopicSpeaker"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
