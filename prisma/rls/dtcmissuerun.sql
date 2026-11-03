-- Bulk DET runs — flat tenant-isolation policy for DtcmIssueRun (1-hop from
-- Event). Nov 3, 2026, docs/DTCM_ETICKET_PLAN.md step 4.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - The worker reads RUNNING runs across tenants; it enters each run's own
--     lane (runWithTenant(run.organizationId)) before touching its rows, the
--     same shape as the certificate worker.
--   - `activeKey` holds an event id while a run is live; event ids are cuids,
--     so the uniqueness can never collide across tenants.

ALTER TABLE "DtcmIssueRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dtcmissuerun_tenant_isolation ON "DtcmIssueRun";
CREATE POLICY dtcmissuerun_tenant_isolation ON "DtcmIssueRun"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
