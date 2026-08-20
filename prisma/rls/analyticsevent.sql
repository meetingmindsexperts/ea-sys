-- AnalyticsEvent. Born tenancy-compliant (docs/ANALYTICS_PLAN.md §4.7).
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role.
-- Fail-closed on an unset GUC.
--
-- Domain notes:
--   - The policy is SYMMETRIC and strict, unlike EmailLog/AuditLog/HelpChatQuery
--     which admit NULL-org rows. It can be strict because a hit is only ever
--     written after its site has been resolved to an organisation: the ingest
--     route DROPS an unresolvable hit rather than storing it org-less. A hit we
--     cannot attribute is worth nothing anyway, so there is no "do not lose it"
--     pressure pushing towards a permissive WITH CHECK.
--
--   - Writes use createMany, never create(). That is not incidental: create()
--     issues INSERT..RETURNING, which the strict USING clause would reject even
--     for a row the WITH CHECK admits. This is the Domain-#18/#19 lesson, and
--     the buffered writer is batch-only for unrelated reasons anyway.
--
--   - The buffer can hold hits for SEVERAL organisations at once, since one
--     container serves every tenant. The writer therefore groups by
--     organizationId and issues one createMany per org inside that org's lane;
--     a single batch under one lane would be rejected here, which is the
--     correct outcome and the reason the grouping exists.

ALTER TABLE "AnalyticsEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analyticsevent_tenant_isolation ON "AnalyticsEvent";
CREATE POLICY analyticsevent_tenant_isolation ON "AnalyticsEvent"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
