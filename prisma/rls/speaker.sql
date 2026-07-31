-- Row-Level Security policies: Speaker domain (Phase-2 sweep, July 2026) —
-- Speaker + SpeakerDocument. Both gained a denormalized organizationId in
-- migration 20260730160000 (columns over join-policies,
-- MULTI_TENANCY_IMPACT.md §8.2), backfilled 1/2-hop from the owning Event.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * Speaker is the CLEAN case — every row has eventId, so the backfill is
--     100% and there are no NULL-org (fail-closed) rows on the platform.
--   * Speaker holds faculty PII + the (faculty + presenter) agreement snapshots;
--     SpeakerDocument holds uploaded agreement copies / CVs (reached via its
--     speaker parent, org-stamped for completeness so the flat policy applies).
--   * Speaker.email is only @@unique([eventId, email]) — a per-event uniqueness,
--     so BOTH orgs can hold a speaker on the SAME email string; the flat policy
--     lane-scopes an unscoped by-email lookup (the ticketing shared-code shape).
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Speaker" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS speaker_tenant_isolation ON "Speaker";
CREATE POLICY speaker_tenant_isolation ON "Speaker"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SpeakerDocument" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS speakerdocument_tenant_isolation ON "SpeakerDocument";
CREATE POLICY speakerdocument_tenant_isolation ON "SpeakerDocument"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
