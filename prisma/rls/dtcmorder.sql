-- DET purchase attempts — flat tenant-isolation policy for DtcmOrder (1-hop
-- from Event). Nov 3, 2026, docs/DTCM_ETICKET_PLAN.md step 3.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - `activeKey` is globally unique (it holds a registration id while an
--     attempt is live). Registration ids are cuids, so two tenants can never
--     collide on it; the uniqueness is a per-registration guard, not a
--     cross-tenant one.
--   - The barcode that grants entry is `Registration.dtcmBarcode`, covered by
--     prisma/rls/registration.sql. This row is the record of the DET purchase.

ALTER TABLE "DtcmOrder" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dtcmorder_tenant_isolation ON "DtcmOrder";
CREATE POLICY dtcmorder_tenant_isolation ON "DtcmOrder"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
