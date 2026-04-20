-- Per-send email audit log. Every sendEmail() call writes a row here so we
-- can render an "Email History" card on Registration / Speaker / Contact
-- detail sheets and investigate delivery issues after the fact.

-- Enums
CREATE TYPE "EmailLogEntityType" AS ENUM ('REGISTRATION', 'SPEAKER', 'CONTACT', 'USER', 'OTHER');
CREATE TYPE "EmailLogStatus" AS ENUM ('SENT', 'FAILED');

-- Table
CREATE TABLE "EmailLog" (
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

-- Indexes
CREATE INDEX "EmailLog_entityType_entityId_idx" ON "EmailLog"("entityType", "entityId");
CREATE INDEX "EmailLog_organizationId_idx" ON "EmailLog"("organizationId");
CREATE INDEX "EmailLog_eventId_idx" ON "EmailLog"("eventId");
CREATE INDEX "EmailLog_to_idx" ON "EmailLog"("to");
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- Foreign keys (all SetNull so deleting the entity preserves history)
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_triggeredByUserId_fkey"
    FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
