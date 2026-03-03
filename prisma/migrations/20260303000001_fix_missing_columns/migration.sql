-- Migration: fix_missing_columns
-- Ensures all columns exist on every table, regardless of which version of
-- the schema was used when db push originally created them.
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS).

-- ============================================
-- Attendee table — columns added after init
-- ============================================

ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "photo" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "registrationType" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Rename company→organization if still on old name
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Attendee' AND column_name = 'company'
  ) THEN
    ALTER TABLE "Attendee" RENAME COLUMN "company" TO "organization";
  END IF;
END $$;
-- Ensure column exists regardless of rename path
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "organization" TEXT;

-- ============================================
-- Speaker table — columns added after init
-- ============================================

ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "registrationType" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Rename company→organization if still on old name
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Speaker' AND column_name = 'company'
  ) THEN
    ALTER TABLE "Speaker" RENAME COLUMN "company" TO "organization";
  END IF;
END $$;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "organization" TEXT;

-- Rename headshot→photo if still on old name
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Speaker' AND column_name = 'headshot'
  ) THEN
    ALTER TABLE "Speaker" RENAME COLUMN "headshot" TO "photo";
  END IF;
END $$;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "photo" TEXT;

-- ============================================
-- Event table — columns added after init
-- ============================================

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "eventType" "EventType";
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "tag" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "footerHtml" TEXT;

-- ============================================
-- Abstract table — columns added after init
-- ============================================

ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "managementToken" TEXT;

-- ============================================
-- User table — columns added after init
-- ============================================

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "specialty" TEXT;

-- ============================================
-- Contact table — add any missing columns
-- ============================================

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "organization" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "registrationType" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "photo" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- ============================================
-- ApiKey table — add any missing columns
-- ============================================

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "prefix" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
