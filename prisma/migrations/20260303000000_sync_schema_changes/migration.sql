-- Migration: sync_schema_changes
-- Adds all schema changes applied via `prisma db push` that were never tracked
-- in migration files. All statements use IF NOT EXISTS / EXCEPTION handling
-- so this migration is safe on databases where changes already exist.

-- ============================================
-- 1. New Enums
-- ============================================

-- Create Title enum
DO $$ BEGIN
  CREATE TYPE "Title" AS ENUM ('MR', 'MS', 'MRS', 'DR', 'PROF', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create EventType enum
DO $$ BEGIN
  CREATE TYPE "EventType" AS ENUM ('CONFERENCE', 'WEBINAR', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add SUBMITTER to UserRole enum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SUBMITTER';

-- ============================================
-- 2. Alter User table
-- ============================================

-- Make organizationId nullable (for REVIEWER and SUBMITTER roles)
ALTER TABLE "User" ALTER COLUMN "organizationId" DROP NOT NULL;

-- Add specialty column
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "specialty" TEXT;

-- ============================================
-- 3. Alter Attendee table
-- ============================================

-- Rename company to organization (if not already renamed)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Attendee' AND column_name = 'company'
  ) THEN
    ALTER TABLE "Attendee" RENAME COLUMN "company" TO "organization";
  END IF;
END $$;

-- Add new columns
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "photo" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "registrationType" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add unique index on email (using CREATE INDEX IF NOT EXISTS — safe if db push already created it)
CREATE UNIQUE INDEX IF NOT EXISTS "Attendee_email_key" ON "Attendee"("email");

-- ============================================
-- 4. Alter Speaker table
-- ============================================

-- Rename company to organization (if not already renamed)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Speaker' AND column_name = 'company'
  ) THEN
    ALTER TABLE "Speaker" RENAME COLUMN "company" TO "organization";
  END IF;
END $$;

-- Rename headshot to photo (if not already renamed)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Speaker' AND column_name = 'headshot'
  ) THEN
    ALTER TABLE "Speaker" RENAME COLUMN "headshot" TO "photo";
  END IF;
END $$;

-- Add new columns
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "registrationType" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ============================================
-- 5. Alter Event table
-- ============================================

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "eventType" "EventType";
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "tag" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "footerHtml" TEXT;

-- ============================================
-- 6. Alter Abstract table
-- ============================================

ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "managementToken" TEXT;

-- Add unique index on managementToken
CREATE UNIQUE INDEX IF NOT EXISTS "Abstract_managementToken_key" ON "Abstract"("managementToken");

-- ============================================
-- 7. Add composite indexes on Registration
-- ============================================

CREATE INDEX IF NOT EXISTS "Registration_eventId_status_idx"
  ON "Registration"("eventId", "status");

CREATE INDEX IF NOT EXISTS "Registration_eventId_ticketTypeId_idx"
  ON "Registration"("eventId", "ticketTypeId");

-- ============================================
-- 8. Create Contact table
-- ============================================

CREATE TABLE IF NOT EXISTS "Contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" "Title",
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "organization" TEXT,
    "jobTitle" TEXT,
    "specialty" TEXT,
    "registrationType" TEXT,
    "phone" TEXT,
    "photo" TEXT,
    "city" TEXT,
    "country" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- Contact indexes
CREATE INDEX IF NOT EXISTS "Contact_organizationId_idx"
  ON "Contact"("organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_organizationId_email_key"
  ON "Contact"("organizationId", "email");

-- Contact foreign key
DO $$ BEGIN
  ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- 9. Create ApiKey table
-- ============================================

CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- ApiKey indexes
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

CREATE INDEX IF NOT EXISTS "ApiKey_organizationId_idx"
  ON "ApiKey"("organizationId");

CREATE INDEX IF NOT EXISTS "ApiKey_isActive_idx"
  ON "ApiKey"("isActive");

-- ApiKey foreign key
DO $$ BEGIN
  ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
