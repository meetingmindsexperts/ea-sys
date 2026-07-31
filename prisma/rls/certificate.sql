-- Row-Level Security policies: certificates domain (Phase-2 sweep, Domain #13,
-- July 2026) — CertificateTemplate, IssuedCertificate, CertificateIssueRun,
-- CertificateSerialCounter (1-hop from Event) + CertificateIssueRunItem (2-hop
-- via CertificateIssueRun). CertificateSerialCounter is a composite-PK counter
-- (@@id([eventId, type])) with a scalar denormalized organizationId — the
-- RegistrationSerialCounter flat-column pattern (its atomic INSERT…ON CONFLICT
-- upsert against a policy-invisible row would raise a spurious unique violation).
-- All 5 gained the column in migration 20260731180000, backfilled from the owning
-- Event in hop order.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * All certificate routes are SESSION-org (org-staff only, requireOrgId /
--     session.user.organizationId + denyReviewer) — every handler wraps its
--     swept read/write in runWithTenant(<session org>).
--   * The cert WORKER (issue-worker.tickAllRuns) scans candidate runs org-blind,
--     then wraps each run's render/send in runWithTenant(run.organizationId) so
--     the swept cert writes + Registration/Speaker reads run in the tenant scope.
--     auto-issue's per-registration wrap (from the Registration sweep) already
--     covers the survey-gated path. Null-org rows (legacy/master) → "" → passthrough.
--   * Every cert create (deliver/bundle/issue-worker/auto-issue + the run/template
--     routes) stamps organizationId so WITH CHECK admits the row; the serial
--     counter's create branch stamps it so the ON CONFLICT upsert can't spuriously
--     collide against a policy-invisible row.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "CertificateTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificatetemplate_tenant_isolation ON "CertificateTemplate";
CREATE POLICY certificatetemplate_tenant_isolation ON "CertificateTemplate"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "IssuedCertificate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS issuedcertificate_tenant_isolation ON "IssuedCertificate";
CREATE POLICY issuedcertificate_tenant_isolation ON "IssuedCertificate"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "CertificateIssueRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificateissuerun_tenant_isolation ON "CertificateIssueRun";
CREATE POLICY certificateissuerun_tenant_isolation ON "CertificateIssueRun"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "CertificateSerialCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificateserialcounter_tenant_isolation ON "CertificateSerialCounter";
CREATE POLICY certificateserialcounter_tenant_isolation ON "CertificateSerialCounter"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "CertificateIssueRunItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificateissuerunitem_tenant_isolation ON "CertificateIssueRunItem";
CREATE POLICY certificateissuerunitem_tenant_isolation ON "CertificateIssueRunItem"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
