-- Row-Level Security policy: Contact domain (Phase-2 pilot, July 2026).
--
-- WHERE THIS RUNS — and where it deliberately does NOT
-- ----------------------------------------------------
-- This file is applied by:
--   1. the tenant-isolation harness (tests/tenancy/global-setup.ts applies
--      tests/tenancy/policies/*.sql, then every prisma/rls/*.sql), and
--   2. the future PLATFORM instance's bootstrap (docs/MULTI_TENANCY.md §0 —
--      the greenfield multi-tenant deployment applies prisma/rls/*.sql at
--      birth, alongside the same non-owner app-role split the harness uses;
--      see tests/tenancy/policies/00-roles.sql, the reference architecture).
--
-- It is NEVER a prisma migration. Master (single-org prod) keeps a database
-- with ZERO RLS objects — auditable via pg_policies, no false sense of
-- enforcement, no latent outage if master's connection role ever changes.
-- FORCE in a chain migration would be an instant master outage (owner role +
-- RLS_SET_LOCAL off → NULL GUC → fail-closed on every Contact query), and
-- even ENABLE-only is excluded by policy so policy definitions stay
-- single-sourced here instead of smeared across timestamped migrations.
--
-- DELIBERATELY NO FORCE ROW LEVEL SECURITY
-- ----------------------------------------
-- Enforcement comes from connecting as a NON-owner app role (harness:
-- app_user; platform: same split). FORCE would also bind the OWNER role,
-- breaking owner-side provisioning (db push, seeds, migrations) on any
-- database where this file was previously applied — policies persist, so a
-- warm harness DB would reject the owner seed's inserts under WITH CHECK.
-- If a deployment must connect as the table owner, FORCE belongs in that
-- deployment's own bootstrap, not in this shared file.
--
-- THE TRIPWIRE (review H1, owner decision: refuse to boot)
-- --------------------------------------------------------
-- Because enforcement depends on the CONNECTION ROLE, a deployment that
-- applies this file but wires an owner connection (Supabase's default
-- string!) would silently no-op every policy. src/lib/tenant/rls-assert.ts
-- closes that hole: under RLS_SET_LOCAL=1 both the web tier
-- (src/instrumentation.ts) and the worker (worker/index.ts) assert
-- row_security_active() on every policied table at startup and REFUSE TO
-- BOOT if the role bypasses RLS or no policies were applied.
--
-- Shape: FLAT policy on the row's own organizationId column — ratified by
-- the Contacts pilot as the recipe for every organizationId-bearing table
-- (docs/MULTI_TENANCY_IMPACT.md §7). current_setting(..., true) returns NULL
-- (not an error) when the GUC is unset, so a missing tenant context
-- fail-closes to zero rows. Idempotent: safe to re-run. Re-apply note: the
-- DROP+CREATE below run as separate autocommit statements, so a re-apply on
-- a LIVE database has a brief RLS-enabled-with-no-policy window — that is
-- default-DENY (a blip of zero rows), never a leak; the fail-closed
-- direction is accepted.
--
-- FOR ALL TO PUBLIC is written out explicitly (it IS the default) so a
-- future domain copy can't accidentally narrow to FOR SELECT and silently
-- lose write enforcement — this file is the template every domain copies.

ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_tenant_isolation ON "Contact";
CREATE POLICY contact_tenant_isolation ON "Contact"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
