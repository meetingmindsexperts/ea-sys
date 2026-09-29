-- RLS for SubmissionShareLink (Sep 29, 2026; docs/SUBMISSION_SHARE_PLAN.md).
-- Born tenant-correct: organizationId is stamped from the Event at create and
-- every read runs inside runWithTenant (the public route resolves the event's
-- org from the slug first). Flat policy, the program-domain convention.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "SubmissionShareLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submissionsharelink_tenant_isolation ON "SubmissionShareLink";
CREATE POLICY submissionsharelink_tenant_isolation ON "SubmissionShareLink"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
