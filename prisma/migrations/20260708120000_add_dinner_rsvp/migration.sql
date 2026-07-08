-- Dinner RSVP. Additive + blue-green safe (new enum + tables; old code ignores them).

DO $$ BEGIN
  CREATE TYPE "RsvpStatus" AS ENUM ('PENDING', 'RESPONDED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "RsvpDinner" (
  "id"           TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "dinnerAt"     TIMESTAMP(3) NOT NULL,
  "location"     TEXT,
  "description"  TEXT,
  "rsvpDeadline" TIMESTAMP(3),
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RsvpDinner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RsvpInvite" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "token"          TEXT NOT NULL,
  "inviteeName"    TEXT NOT NULL,
  "inviteeEmail"   TEXT NOT NULL,
  "registrationId" TEXT,
  "speakerId"      TEXT,
  "dietary"        TEXT,
  "status"         "RsvpStatus" NOT NULL DEFAULT 'PENDING',
  "respondedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RsvpInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RsvpDinnerResponse" (
  "id"         TEXT NOT NULL,
  "inviteId"   TEXT NOT NULL,
  "dinnerId"   TEXT NOT NULL,
  "attending"  BOOLEAN NOT NULL DEFAULT false,
  "guestCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RsvpDinnerResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RsvpInvite_token_key" ON "RsvpInvite"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "RsvpInvite_eventId_inviteeEmail_key" ON "RsvpInvite"("eventId", "inviteeEmail");
CREATE UNIQUE INDEX IF NOT EXISTS "RsvpDinnerResponse_inviteId_dinnerId_key" ON "RsvpDinnerResponse"("inviteId", "dinnerId");
CREATE INDEX IF NOT EXISTS "RsvpDinner_eventId_idx" ON "RsvpDinner"("eventId");
CREATE INDEX IF NOT EXISTS "RsvpInvite_eventId_idx" ON "RsvpInvite"("eventId");
CREATE INDEX IF NOT EXISTS "RsvpInvite_eventId_status_idx" ON "RsvpInvite"("eventId", "status");
CREATE INDEX IF NOT EXISTS "RsvpDinnerResponse_dinnerId_idx" ON "RsvpDinnerResponse"("dinnerId");
CREATE INDEX IF NOT EXISTS "RsvpDinnerResponse_inviteId_idx" ON "RsvpDinnerResponse"("inviteId");

DO $$ BEGIN
  ALTER TABLE "RsvpDinner" ADD CONSTRAINT "RsvpDinner_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "RsvpInvite" ADD CONSTRAINT "RsvpInvite_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "RsvpDinnerResponse" ADD CONSTRAINT "RsvpDinnerResponse_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RsvpInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "RsvpDinnerResponse" ADD CONSTRAINT "RsvpDinnerResponse_dinnerId_fkey" FOREIGN KEY ("dinnerId") REFERENCES "RsvpDinner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
