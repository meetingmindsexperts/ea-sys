-- Tenant-isolation harness: the two-role split.
--
-- RLS does NOT apply to superusers, and table OWNERS bypass it unless FORCE.
-- So the harness provisions with the owner role (postgres via
-- TENANCY_DIRECT_URL: db push, policies, seed) and runs the tests as a
-- NON-owner `app_user` through pgbouncer (TENANCY_DATABASE_URL) — matching
-- how a production app role would look under RLS in Phase 2.
--
-- Idempotent: safe to re-run on a warm container.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_pw';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
