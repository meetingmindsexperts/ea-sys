-- Idempotent corrective migration.
--
-- Background: migrations 20260421000000 (PaymentStatus.UNASSIGNED) and
-- 20260421000100 (EmailLog) were committed and the deploy reported
-- "No pending migrations to apply" — but the production enum does not
-- contain UNASSIGNED. The Prisma migrations table believes those rows
-- ran; the SQL didn't. This migration re-applies both changes safely:
--   - ALTER TYPE ... ADD VALUE IF NOT EXISTS is already idempotent.
--   - The EmailLog bits are wrapped in IF NOT EXISTS / DO $$ ... $$
--     guards so running them twice is safe.

-- ── PaymentStatus.UNASSIGNED ────────────────────────────────────────────────
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'UNASSIGNED';

-- ── EmailLog enums (guarded so they don't fail if already created) ─────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailLogEntityType') THEN
    CREATE TYPE "EmailLogEntityType" AS ENUM ('REGISTRATION', 'SPEAKER', 'CONTACT', 'USER', 'OTHER');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailLogStatus') THEN
    CREATE TYPE "EmailLogStatus" AS ENUM ('SENT', 'FAILED');
  END IF;
END
$$;

-- ── EmailLog table + indexes + FKs (all IF NOT EXISTS) ─────────────────────
CREATE TABLE IF NOT EXISTS "EmailLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "eventId" TEXT,
    "entityType" "EmailLogEntityType",
    "entityId" TEXT,
    "to" TEXT NOT NULL,
    "cc" TEXT,
    "bcc" TEXT,
    "subject" TEXT NOT NULL,
    "templateSlug" TEXT,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "EmailLogStatus" NOT NULL,
    "errorMessage" TEXT,
    "triggeredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmailLog_entityType_entityId_idx" ON "EmailLog"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "EmailLog_organizationId_idx" ON "EmailLog"("organizationId");
CREATE INDEX IF NOT EXISTS "EmailLog_eventId_idx" ON "EmailLog"("eventId");
CREATE INDEX IF NOT EXISTS "EmailLog_to_idx" ON "EmailLog"("to");
CREATE INDEX IF NOT EXISTS "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- Foreign keys — Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard
-- each one with a pg_constraint lookup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmailLog_organizationId_fkey') THEN
    ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmailLog_eventId_fkey') THEN
    ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmailLog_triggeredByUserId_fkey') THEN
    ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_triggeredByUserId_fkey"
      FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
