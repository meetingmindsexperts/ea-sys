-- Create AttendeeRole enum
DO $$ BEGIN
  CREATE TYPE "AttendeeRole" AS ENUM ('ACADEMIA', 'ALLIED_HEALTH', 'MEDICAL_DEVICES', 'PHARMA', 'PHYSICIAN', 'RESIDENT', 'SPEAKER', 'STUDENT', 'OTHERS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Remove OTHER from Title enum (safe: no-op if already removed)
-- Note: Postgres doesn't support DROP VALUE from enum natively.
-- Existing rows with OTHER will remain but new inserts won't use it.

-- Add new fields to Attendee
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "role" "AttendeeRole";
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "additionalEmail" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "customSpecialty" TEXT;

-- Add new fields to Speaker
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "role" "AttendeeRole";
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "additionalEmail" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "customSpecialty" TEXT;

-- Add new fields to Contact
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "role" "AttendeeRole";
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "additionalEmail" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "customSpecialty" TEXT;
