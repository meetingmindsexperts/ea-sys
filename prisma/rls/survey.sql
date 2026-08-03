-- Survey domain (Domain #16) — flat tenant-isolation policy for
-- SurveyResponse (Aug 3, 2026).
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC (`current_setting(..., true)`
-- returns NULL → the predicate is never true).
--
-- Domain notes:
--   - SurveyResponse carries its own eventId → clean 1-hop org column,
--     backfilled by migration 20260803150000; the ONE writer (the public
--     survey submit — token / share / self-identify paths, all already
--     wrapped + tenantTransaction'd by the Reg-core sweep) stamps
--     registration.event.organizationId.
--   - registrationId is GLOBALLY unique (@unique, the one-response dedup
--     gate) — a cross-tenant findUnique({ registrationId }) must miss, same
--     class as the RSVP token / IssuedCertificate serial proofs.
--   - The two dashboard readers (responses list/aggregate + CSV export)
--     authorize via buildEventAccessWhere and wrap in the RESOURCE org
--     (org-null SUPER_ADMIN reaches them).

ALTER TABLE "SurveyResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS surveyresponse_tenant_isolation ON "SurveyResponse";
CREATE POLICY surveyresponse_tenant_isolation ON "SurveyResponse"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
