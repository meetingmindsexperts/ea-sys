-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ScheduledEmailStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ScheduledEmail" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "recipientType" TEXT NOT NULL,
  "emailType" TEXT NOT NULL,
  "customSubject" TEXT,
  "customMessage" TEXT,
  "attachments" JSONB,
  "filters" JSONB,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" "ScheduledEmailStatus" NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "successCount" INTEGER,
  "failureCount" INTEGER,
  "totalCount" INTEGER,
  "lastError" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ScheduledEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledEmail_status_scheduledFor_idx" ON "ScheduledEmail"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledEmail_eventId_status_idx" ON "ScheduledEmail"("eventId", "status");

-- AddForeignKey
ALTER TABLE "ScheduledEmail"
  ADD CONSTRAINT "ScheduledEmail_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail"
  ADD CONSTRAINT "ScheduledEmail_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail"
  ADD CONSTRAINT "ScheduledEmail_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
