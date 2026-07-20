-- Speaker reimbursement — web replacement for the paper "Speaker / Faculty
-- Reimbursement Form" (bank wire transfer request).
--
-- Additive + idempotent. One new enum + two new tables; nothing altered or
-- dropped, so it is blue-green safe (the old container never touches them).
-- v1 is submission-only: PENDING → SUBMITTED, organizer may reopen.

DO $$ BEGIN
  CREATE TYPE "ReimbursementStatus" AS ENUM ('PENDING', 'SUBMITTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "SpeakerReimbursement" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "speakerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "ReimbursementStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT,
    "designation" TEXT,
    "institution" TEXT,
    "country" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "nationality" TEXT,
    "passportNumber" TEXT,
    "roleAtEvent" TEXT,
    "claimLines" JSONB,
    "bankDetails" JSONB,
    "signedName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedIp" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeakerReimbursement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SpeakerReimbursement_speakerId_key"
    ON "SpeakerReimbursement" ("speakerId");
CREATE UNIQUE INDEX IF NOT EXISTS "SpeakerReimbursement_token_key"
    ON "SpeakerReimbursement" ("token");
CREATE INDEX IF NOT EXISTS "SpeakerReimbursement_eventId_idx"
    ON "SpeakerReimbursement" ("eventId");
CREATE INDEX IF NOT EXISTS "SpeakerReimbursement_eventId_status_idx"
    ON "SpeakerReimbursement" ("eventId", "status");

DO $$ BEGIN
  ALTER TABLE "SpeakerReimbursement" ADD CONSTRAINT "SpeakerReimbursement_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerReimbursement" ADD CONSTRAINT "SpeakerReimbursement_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "SpeakerReimbursementDocument" (
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpeakerReimbursementDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SpeakerReimbursementDocument_reimbursementId_idx"
    ON "SpeakerReimbursementDocument" ("reimbursementId");

DO $$ BEGIN
  ALTER TABLE "SpeakerReimbursementDocument" ADD CONSTRAINT "SpeakerReimbursementDocument_reimbursementId_fkey"
    FOREIGN KEY ("reimbursementId") REFERENCES "SpeakerReimbursement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
