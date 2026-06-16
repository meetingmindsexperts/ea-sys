-- Add the ONSITE value to the UserRole enum.
--
-- Additive + idempotent (IF NOT EXISTS, Postgres 12+ / Supabase is PG17), so it
-- is safe under blue-green deploys: the currently-running container simply never
-- emits the new value, and re-running the migration is a no-op. No existing rows
-- change. `ALTER TYPE ... ADD VALUE` is run outside a transaction by Prisma's
-- migrate engine automatically.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ONSITE';
