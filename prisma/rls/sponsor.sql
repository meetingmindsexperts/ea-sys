-- Row-Level Security policy: Sponsor (Sep 2, 2026).
--
-- Same flat shape as every other per-domain policy; see contact.sql for the
-- full project-wide rationale (applied ONLY by the isolation harness and the
-- platform bootstrap, never a prisma migration, so master keeps a database with
-- zero RLS objects; NO FORCE, because enforcement comes from connecting as a
-- non-owner role, which is also what leaves the dbOperator lane able to work).
--
-- WHAT IS AND IS NOT PROTECTED HERE, because a sponsor is a public-facing thing
-- and that reads like a contradiction. Sponsor ROWS are tenant data: they carry
-- an organisation's commercial relationships, and one tenant enumerating
-- another's sponsor list is a competitive disclosure. What is public is the
-- RENDERED list on an event's own pages, which is served through the public
-- event routes under that event's own tenant lane. Publishing a logo does not
-- make the table world-readable, any more than a published agenda makes
-- EventSession unpoliced.
--
-- Registration.sponsorId and PromoCode.sponsorId are foreign keys into this
-- table as of migration 20260902160000, and both of those tables are policied
-- too, so a cross-tenant join has no lane to run in from either end.

ALTER TABLE "Sponsor" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sponsor_tenant_isolation ON "Sponsor";
CREATE POLICY sponsor_tenant_isolation ON "Sponsor"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
