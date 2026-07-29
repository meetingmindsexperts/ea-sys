-- Row-Level Security policies: Registration-core domain (Phase-2 sweep #8,
-- July 2026) — Registration, Attendee, Payment, RefundAttempt,
-- RegistrationSerialCounter. Second multi-table domain file (after
-- webinar.sql). All 5 gained a denormalized organizationId in migration
-- 20260728160000 (columns over join-policies, MULTI_TENANCY_IMPACT.md §8.2);
-- TicketType/PricingTier/PromoCode are a separate follow-up sweep and are
-- deliberately absent here. See prisma/rls/contact.sql for the full template
-- rationale (harness/platform-bootstrap only, never a migration; NO FORCE —
-- enforcement is the non-owner app role; fail-closed on unset GUC).
--
-- Notes specific to this domain:
--   * Attendee rows with NULL organizationId (orphans / pre-backfill
--     blue-green rows / cross-org-shared rows the old orphan-reuse race
--     minted) fail closed — invisible to every tenant. The org-bound reuse
--     lookup (C1) simply mints a fresh row for them.
--   * RegistrationSerialCounter is FLAT-policied precisely to avoid the
--     INSERT…ON CONFLICT join-policy hazard (a policy-invisible counter row
--     would raise a unique violation misread as "already registered").
--   * App-layer wiring: writers stamp organizationId + the C1 compound-where
--     binds (check-in claims, optimistic-lock write, companion delete, DTCM
--     write) are defence #1; routes/MCP/workers wrap in runWithTenant (C2).
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Registration" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registration_tenant_isolation ON "Registration";
CREATE POLICY registration_tenant_isolation ON "Registration"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Attendee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendee_tenant_isolation ON "Attendee";
CREATE POLICY attendee_tenant_isolation ON "Attendee"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_tenant_isolation ON "Payment";
CREATE POLICY payment_tenant_isolation ON "Payment"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "RefundAttempt" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refundattempt_tenant_isolation ON "RefundAttempt";
CREATE POLICY refundattempt_tenant_isolation ON "RefundAttempt"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "RegistrationSerialCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registrationserialcounter_tenant_isolation ON "RegistrationSerialCounter";
CREATE POLICY registrationserialcounter_tenant_isolation ON "RegistrationSerialCounter"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
