-- Add a combined "Oral or Poster" option alongside the separate ORAL / POSTER.
-- Additive enum value; idempotent. Postgres 12+ allows ADD VALUE IF NOT EXISTS
-- (Supabase is PG 17). Single statement so it isn't wrapped in a txn.
ALTER TYPE "PresentationType" ADD VALUE IF NOT EXISTS 'ORAL_POSTER';
