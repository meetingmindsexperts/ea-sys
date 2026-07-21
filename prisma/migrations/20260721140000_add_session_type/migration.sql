-- Break items on the agenda (registration / coffee break / lunch / networking).
-- Additive + idempotent: safe to re-run and blue-green safe — old containers
-- never read the new column, existing rows default to SESSION.

DO $$ BEGIN
  CREATE TYPE "SessionType" AS ENUM ('SESSION', 'REGISTRATION', 'BREAK', 'LUNCH', 'NETWORKING');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "EventSession"
  ADD COLUMN IF NOT EXISTS "type" "SessionType" NOT NULL DEFAULT 'SESSION';
