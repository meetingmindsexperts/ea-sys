-- CRM in-app notifications — the bell in the CRM shell.
--
-- Additive + idempotent. One new table, nothing altered or dropped, so it is
-- blue-green safe (the old container never touches it). Deliberately a SEPARATE
-- table from the core "Notification" (owner decision, July 17): the CRM stays a
-- bounded module and the event platform's bell never mixes in pipeline traffic.

CREATE TABLE IF NOT EXISTS "CrmNotification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmNotification_userId_isRead_idx"
    ON "CrmNotification" ("userId", "isRead");
CREATE INDEX IF NOT EXISTS "CrmNotification_userId_createdAt_idx"
    ON "CrmNotification" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNotification_organizationId_createdAt_idx"
    ON "CrmNotification" ("organizationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "CrmNotification" ADD CONSTRAINT "CrmNotification_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNotification" ADD CONSTRAINT "CrmNotification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
