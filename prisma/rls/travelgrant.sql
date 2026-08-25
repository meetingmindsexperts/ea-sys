-- Travel Grant domain — flat tenant-isolation policy for TravelGrant
-- (1-hop from Event). Aug 25, 2026. See docs/TRAVEL_GRANT_PLAN.md §7.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - TravelGrant.token is GLOBALLY unique and plaintext (the copyable link),
--     exactly like SpeakerReimbursement.token. The public route therefore MUST
--     bootstrap the org from the un-swept Event by host+slug BEFORE the token
--     findUnique, or every link fail-closes to "invalid". This is not a
--     theoretical ordering nicety: get it backwards and the feature is dead on
--     the platform while passing every test on master, where RLS is off.
--   - speakerId is also globally unique (one grant per Speaker row, and Speaker
--     is itself event-scoped) — a cross-tenant findUnique({ speakerId }) must
--     miss rather than return another tenant's row.
--   - The console authorizes via buildEventAccessWhere and wraps in the
--     RESOURCE org, so an org-null SUPER_ADMIN still reaches it.

ALTER TABLE "TravelGrant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travelgrant_tenant_isolation ON "TravelGrant";
CREATE POLICY travelgrant_tenant_isolation ON "TravelGrant"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
