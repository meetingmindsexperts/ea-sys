-- Row-Level Security policies: abstract domain (Phase-2 sweep, Domain #11,
-- July 2026) — Abstract, AbstractTheme, ReviewCriterion (1-hop from Event) +
-- AbstractReviewer, AbstractReviewSubmission (2-hop via Abstract). All 5 gained a
-- denormalized organizationId in migration 20260731140000, backfilled from the
-- owning Event. The reviewer/submitter User is org-INDEPENDENT, but each ROW
-- belongs to the abstract's event's org, so all 5 are org-scoped.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * The reviewer/submitter-facing routes (submissions POST, abstract PUT/GET,
--     my-profile) wrap in runWithTenant(event.organizationId) — the RESOURCE org,
--     resolved from the abstract's event, NOT the org-null caller session. So a
--     reviewer's submission + a submitter's edit ride the correct tenant store.
--   * The /my-reviews reviewer-portal feed is DELIBERATELY unwrapped (cross-org
--     union across every event; the Phase-1 identity decision) — it fail-closes
--     under RLS until then.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Abstract" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS abstract_tenant_isolation ON "Abstract";
CREATE POLICY abstract_tenant_isolation ON "Abstract"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "AbstractTheme" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS abstracttheme_tenant_isolation ON "AbstractTheme";
CREATE POLICY abstracttheme_tenant_isolation ON "AbstractTheme"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ReviewCriterion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reviewcriterion_tenant_isolation ON "ReviewCriterion";
CREATE POLICY reviewcriterion_tenant_isolation ON "ReviewCriterion"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "AbstractReviewer" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS abstractreviewer_tenant_isolation ON "AbstractReviewer";
CREATE POLICY abstractreviewer_tenant_isolation ON "AbstractReviewer"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "AbstractReviewSubmission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS abstractreviewsubmission_tenant_isolation ON "AbstractReviewSubmission";
CREATE POLICY abstractreviewsubmission_tenant_isolation ON "AbstractReviewSubmission"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
