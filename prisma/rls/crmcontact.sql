-- Row-Level Security policy: CrmContact domain (Phase-2 fast-follow, July 2026).
--
-- Fifth domain to adopt the FLAT per-domain RLS template the Contacts pilot
-- ratified (unblocked July 24 when the CRM module deployed to prod). See
-- prisma/rls/contact.sql for the FULL rationale — this file follows it
-- byte-for-byte in shape and intent:
--   * applied ONLY by the tenant-isolation harness
--     (tests/tenancy/global-setup.ts reads every prisma/rls/*.sql) and the
--     future PLATFORM bootstrap (docs/MULTI_TENANCY.md §0). NEVER a prisma
--     migration — master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY — enforcement comes from connecting as a
--     NON-owner app role (harness: app_user; platform: same split).
--   * FLAT policy on the row's own organizationId column. CrmContact carries a
--     direct organizationId (@@index([organizationId])) — the trivial case.
--   * current_setting(..., true) returns NULL (not an error) when the GUC is
--     unset, so a missing tenant context fail-closes to zero rows.
--   * The rls-assert.ts boot tripwire self-extends over every policied table
--     via pg_policy, so it already covers CrmContact with no code change.
--
-- SCOPE NOTE (policy-only pass, like MediaFile's July-24 state): the CRM
-- routes/services org-bind via requireCrmRead/Write + org-scoped findFirst
-- lookups today (defence #1 by convention), but their by-id mutations are NOT
-- yet compound-where'd and the /api/crm/* handlers are NOT yet wrapped in
-- runWithTenant. This file is the DB backstop (defence #2) the platform
-- bootstrap runs; the C1/C2 route wiring is a follow-on before the platform
-- turns RLS_SET_LOCAL on. On master (flag off) this file is never applied.
-- The OTHER Crm* tables (Company/Deal/Task/Note/Activity/EmailThread/…) are
-- part of the full CRM-domain sweep, not this pass — CrmContact goes first
-- because it holds the PII (the org's business-contact book).
--
-- Idempotent: safe to re-run. The DROP+CREATE run as separate autocommit
-- statements, so a re-apply on a LIVE database has a brief
-- RLS-enabled-with-no-policy window — that is default-DENY (zero rows), never
-- a leak; the fail-closed direction is accepted.
--
-- FOR ALL TO PUBLIC is written out explicitly (it IS the default) so a future
-- domain copy can't accidentally narrow to FOR SELECT and silently lose write
-- enforcement.

ALTER TABLE "CrmContact" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crmcontact_tenant_isolation ON "CrmContact";
CREATE POLICY crmcontact_tenant_isolation ON "CrmContact"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
