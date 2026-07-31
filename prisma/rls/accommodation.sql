-- Row-Level Security policies: accommodation domain (Phase-2 sweep, Domain #10,
-- July 2026) — Hotel, RoomType, Accommodation. All 3 gained a denormalized
-- organizationId in migration 20260731100000 (columns over join-policies,
-- MULTI_TENANCY_IMPACT.md §8.2), backfilled 1/2-hop from the owning Event
-- (Hotel←Event, RoomType←Hotel←Event, Accommodation←Event). Clean case: every
-- row belongs to exactly one Event → one org, no orphans (100% backfill).
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * The atomic overbooking guard (RoomType.bookedRooms updateMany inside a
--     tenantTransaction) + the cross-domain room-release on registration/speaker
--     delete both write RoomType/Accommodation — those callers already ride the
--     tenant store (Domain #8 + Speaker sweep), so this policy is the DB backstop.
--   * Hotel/RoomType carry no per-org-unique field; scoping is proven in the
--     harness by per-lane counts, not a shared value.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Hotel" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hotel_tenant_isolation ON "Hotel";
CREATE POLICY hotel_tenant_isolation ON "Hotel"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "RoomType" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roomtype_tenant_isolation ON "RoomType";
CREATE POLICY roomtype_tenant_isolation ON "RoomType"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Accommodation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accommodation_tenant_isolation ON "Accommodation";
CREATE POLICY accommodation_tenant_isolation ON "Accommodation"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
