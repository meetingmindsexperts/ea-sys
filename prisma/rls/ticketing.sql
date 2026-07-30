-- Row-Level Security policies: ticketing domain (Phase-2 sweep, ticketing
-- follow-on to Domain #8, July 2026) — TicketType, PricingTier, PromoCode,
-- PromoCodeRedemption, PromoCodeTicketType. All 5 gained a denormalized
-- organizationId in migration 20260730120000 (columns over join-policies,
-- MULTI_TENANCY_IMPACT.md §8.2), backfilled 1/2-hop from the owning Event.
-- These were deliberately carved off the Registration-core sweep (see
-- prisma/rls/registration.sql) to keep it bounded; the seat/promo counters
-- live here, so this closes that RLS-backstop gap.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * The seat/promo counter writers (soldCount / usedCount) live in
--     registration-seat-db.ts + promo-code-service.ts, reached from the
--     registration flow already wrapped in runWithTenant (Domain #8). This
--     policy is the DB backstop; the writers stamp organizationId on CREATE
--     and the management CRUD routes (tickets / tiers / promo) wrap in
--     runWithTenant (C2). The registrant promo-apply route stays unwrapped —
--     cross-org by design (identity-model decision), same as Domain #8.
--   * PromoCodeTicketType is the promo↔ticket-type link table; always reached
--     via its promo parent, org-stamped for completeness.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "TicketType" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickettype_tenant_isolation ON "TicketType";
CREATE POLICY tickettype_tenant_isolation ON "TicketType"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PricingTier" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pricingtier_tenant_isolation ON "PricingTier";
CREATE POLICY pricingtier_tenant_isolation ON "PricingTier"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PromoCode" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promocode_tenant_isolation ON "PromoCode";
CREATE POLICY promocode_tenant_isolation ON "PromoCode"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PromoCodeRedemption" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promocoderedemption_tenant_isolation ON "PromoCodeRedemption";
CREATE POLICY promocoderedemption_tenant_isolation ON "PromoCodeRedemption"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PromoCodeTicketType" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promocodetickettype_tenant_isolation ON "PromoCodeTicketType";
CREATE POLICY promocodetickettype_tenant_isolation ON "PromoCodeTicketType"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
