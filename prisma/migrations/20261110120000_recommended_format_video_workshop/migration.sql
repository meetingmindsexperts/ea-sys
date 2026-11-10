-- A reviewer's recommended format can be any presentation type the event
-- offers, not only oral or poster (Nov 10, 2026): an event taking Video or
-- Workshop abstracts could not be recommended either. src/lib/recommended-formats.ts.
--
-- ADDITIVE + IDEMPOTENT. `ADD VALUE IF NOT EXISTS` is blue-green safe: the old
-- container never encounters the values (nothing stores them yet), and a re-run
-- is a no-op. Neither value is used in this file, so the Postgres rule that a
-- new enum value cannot be used in the transaction that adds it does not bite.
-- Precedent: 20260827120000_add_hr_user_role.
ALTER TYPE "RecommendedFormat" ADD VALUE IF NOT EXISTS 'VIDEO';
ALTER TYPE "RecommendedFormat" ADD VALUE IF NOT EXISTS 'WORKSHOP';
