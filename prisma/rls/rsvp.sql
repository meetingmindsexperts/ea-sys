-- Row-Level Security policies: Dinner RSVP domain (Phase-2 sweep, Domain #15,
-- August 2026) — RsvpDinner + RsvpInvite (both 1-hop from Event) +
-- RsvpDinnerResponse (2-hop via RsvpInvite). All three gained a denormalized
-- nullable organizationId (migration 20260803130000, backfilled 1/2-hop) and
-- are stamped at every create site.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * The public token surface (GET/POST /api/public/events/[slug]/rsvp/[token])
--     reads RsvpInvite by its GLOBALLY-UNIQUE token — a swept table now, so a
--     token read with NO tenant context fail-closes to null. The route resolves
--     the tenant org from the (un-swept) Event by host+slug FIRST (publicEventWhere)
--     and runs the token lookup inside runWithTenant(that org). A token minted
--     for tenant A therefore returns null on tenant B's lane — the isolation the
--     eventMatchesRequestTenant defense-in-depth already asserted, now enforced
--     at the DB.
--   * RsvpInvite has @@unique([eventId, inviteeEmail]) but NOT a per-org-unique
--     on inviteeEmail alone — BOTH orgs can invite the SAME email address, so an
--     unscoped `where:{ inviteeEmail }` returning only the caller's row is what
--     proves scoping (the shared-value shape). The token is globally unique, so
--     a cross-tenant `findUnique({ token })` returning null proves the public
--     bootstrap above.
--   * RsvpDinnerResponse is 2-hop — its org is stamped from the invite at create
--     (public POST) and backfilled via RsvpInvite. Reading a response by its
--     inviteId still resolves only on the owning tenant's lane.
--   * The public POST replace-all runs in a tenantTransaction (SET LOCAL on its
--     own pooled backend) so the delete/create/update all ride the tenant lane.
--   * MCP list_dinner_rsvps wraps with the session (API-key) org; no cron worker
--     touches these tables.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "RsvpDinner" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rsvpdinner_tenant_isolation ON "RsvpDinner";
CREATE POLICY rsvpdinner_tenant_isolation ON "RsvpDinner"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "RsvpInvite" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rsvpinvite_tenant_isolation ON "RsvpInvite";
CREATE POLICY rsvpinvite_tenant_isolation ON "RsvpInvite"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "RsvpDinnerResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rsvpdinnerresponse_tenant_isolation ON "RsvpDinnerResponse";
CREATE POLICY rsvpdinnerresponse_tenant_isolation ON "RsvpDinnerResponse"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
