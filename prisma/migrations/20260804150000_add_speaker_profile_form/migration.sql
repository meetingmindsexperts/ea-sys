-- Speaker profile form — public token link where a speaker submits their own
-- photo (→ Speaker.photo), passport photocopy (required) + cover letter
-- (optional) as SpeakerDocument rows, and their bio (→ Speaker.bio).
--
-- Additive + idempotent. One new enum + one new table; nothing altered or
-- dropped, so it is blue-green safe (the old container never touches them).
-- v1 is submission-only: PENDING → SUBMITTED, organizer may reopen.

DO $$ BEGIN
  CREATE TYPE "SpeakerProfileFormStatus" AS ENUM ('PENDING', 'SUBMITTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "SpeakerProfileForm" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "speakerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "SpeakerProfileFormStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "submittedIp" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeakerProfileForm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SpeakerProfileForm_speakerId_key"
    ON "SpeakerProfileForm" ("speakerId");

CREATE UNIQUE INDEX IF NOT EXISTS "SpeakerProfileForm_token_key"
    ON "SpeakerProfileForm" ("token");

CREATE INDEX IF NOT EXISTS "SpeakerProfileForm_eventId_idx"
    ON "SpeakerProfileForm" ("eventId");

CREATE INDEX IF NOT EXISTS "SpeakerProfileForm_organizationId_idx"
    ON "SpeakerProfileForm" ("organizationId");

DO $$ BEGIN
  ALTER TABLE "SpeakerProfileForm"
    ADD CONSTRAINT "SpeakerProfileForm_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerProfileForm"
    ADD CONSTRAINT "SpeakerProfileForm_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
