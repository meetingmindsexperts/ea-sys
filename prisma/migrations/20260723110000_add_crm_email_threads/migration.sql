-- CRM email inbox (July 23, 2026): threads + messages so sponsor replies land
-- in the CRM. A thread is minted on every CRM outbound send; its unique
-- replyToken is the tokenized Reply-To local part, so inbound replies resolve
-- exactly. Additive + idempotent.

DO $$ BEGIN
  CREATE TYPE "CrmEmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CrmEmailThread" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "dealId" TEXT,
  "crmContactId" TEXT,
  "subject" TEXT NOT NULL,
  "replyToken" TEXT NOT NULL,
  "counterpartyEmail" TEXT NOT NULL,
  "counterpartyName" TEXT,
  "hasUnread" BOOLEAN NOT NULL DEFAULT false,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmEmailMessage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "direction" "CrmEmailDirection" NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "fromName" TEXT,
  "subject" TEXT,
  "textBody" TEXT,
  "htmlBody" TEXT,
  "messageId" TEXT,
  "inReplyTo" TEXT,
  "providerMessageId" TEXT,
  "s3Key" TEXT,
  "attachments" JSONB,
  "spamVerdict" TEXT,
  "sentByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailThread_replyToken_key" ON "CrmEmailThread"("replyToken");
CREATE INDEX IF NOT EXISTS "CrmEmailThread_organizationId_lastMessageAt_idx" ON "CrmEmailThread"("organizationId", "lastMessageAt" DESC);
CREATE INDEX IF NOT EXISTS "CrmEmailThread_dealId_idx" ON "CrmEmailThread"("dealId");
CREATE INDEX IF NOT EXISTS "CrmEmailThread_crmContactId_idx" ON "CrmEmailThread"("crmContactId");
CREATE INDEX IF NOT EXISTS "CrmEmailMessage_threadId_createdAt_idx" ON "CrmEmailMessage"("threadId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmEmailMessage_organizationId_idx" ON "CrmEmailMessage"("organizationId");

DO $$ BEGIN
  ALTER TABLE "CrmEmailThread" ADD CONSTRAINT "CrmEmailThread_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmEmailThread" ADD CONSTRAINT "CrmEmailThread_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmEmailThread" ADD CONSTRAINT "CrmEmailThread_crmContactId_fkey"
    FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmEmailMessage" ADD CONSTRAINT "CrmEmailMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "CrmEmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmEmailMessage" ADD CONSTRAINT "CrmEmailMessage_sentByUserId_fkey"
    FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
