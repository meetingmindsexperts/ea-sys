-- DTCM code pool — flat tenant-isolation policy for DtcmCode (1-hop from
-- Event). Aug 25, 2026.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - `code` is unique per EVENT, not globally, so two tenants can legitimately
--     hold the same value in their pools. An unscoped read by code must
--     therefore resolve to the caller's own row and nothing else — that is the
--     MediaFile shared-url shape, and it is what the test proves.
--   - The value that actually grants entry is `Registration.dtcmBarcode`,
--     which is covered by prisma/rls/registration.sql. A pool row is only the
--     record of what was issued.
--   - Every write goes through a route that is already swept, so the lane is
--     inherited rather than re-established here.

ALTER TABLE "DtcmCode" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dtcmcode_tenant_isolation ON "DtcmCode";
CREATE POLICY dtcmcode_tenant_isolation ON "DtcmCode"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
