-- Row-Level Security policy: MediaFile domain (Phase-2 fast-follow, July 2026).
--
-- Second domain to adopt the FLAT per-domain RLS template the Contacts pilot
-- ratified. See prisma/rls/contact.sql for the FULL rationale — this file
-- follows it byte-for-byte in shape and intent:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap (docs/MULTI_TENANCY.md §0). NEVER a prisma
--     migration — master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: same split). FORCE
--     would break owner-side provisioning and belongs in a deployment's own
--     bootstrap if that deployment must connect as the table owner.
--   * FLAT policy on the row's own organizationId column. MediaFile carries a
--     direct organizationId (@@index([organizationId])) — the trivial case,
--     no join needed.
--   * current_setting(..., true) returns NULL (not an error) when the GUC is
--     unset, so a missing tenant context fail-closes to zero rows.
--   * The rls-assert.ts boot tripwire (src/instrumentation.ts + worker/index.ts)
--     self-extends over every policied table via pg_policy, so it already
--     covers MediaFile — a deployment that applies this file but wires an
--     OWNER connection refuses to boot.
--
-- SCOPE NOTE (Phase-2 recipe steps C1–C3 deferred): the media routes today
-- org-bind via a preceding findFirst (defence #1 by convention), and do NOT
-- yet compound-where their mutations or wrap in runWithTenant. This file is the
-- DB backstop (defence #2) the platform bootstrap runs; the route wiring is a
-- follow-on before the platform turns RLS_SET_LOCAL on. On master (flag off)
-- this file is never applied, so the deferral is inert.
--
-- Idempotent: safe to re-run. The DROP+CREATE run as separate autocommit
-- statements, so a re-apply on a LIVE database has a brief
-- RLS-enabled-with-no-policy window — that is default-DENY (zero rows), never a
-- leak; the fail-closed direction is accepted.
--
-- FOR ALL TO PUBLIC is written out explicitly (it IS the default) so a future
-- domain copy can't accidentally narrow to FOR SELECT and silently lose write
-- enforcement.

ALTER TABLE "MediaFile" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mediafile_tenant_isolation ON "MediaFile";
CREATE POLICY mediafile_tenant_isolation ON "MediaFile"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
