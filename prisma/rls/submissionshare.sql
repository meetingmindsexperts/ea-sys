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

-- RegistrationShareLink (Sep 29, 2026; docs/REGISTRATION_SHARE_PLAN.md): the
-- named registration views. Same flat policy, same lane discipline.
ALTER TABLE "RegistrationShareLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registrationsharelink_tenant_isolation ON "RegistrationShareLink";
CREATE POLICY registrationsharelink_tenant_isolation ON "RegistrationShareLink"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

-- VenueShareLink (Nov 2, 2026; docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10):
-- the exhibitor floor plan link. Same flat policy; the public route opens the
-- lane from the event's org before reading the row.
ALTER TABLE "VenueShareLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venuesharelink_tenant_isolation ON "VenueShareLink";
CREATE POLICY venuesharelink_tenant_isolation ON "VenueShareLink"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
