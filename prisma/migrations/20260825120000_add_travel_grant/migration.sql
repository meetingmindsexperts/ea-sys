-- Travel Grant: a consent record for an abstract author based outside the UAE.
-- See docs/TRAVEL_GRANT_PLAN.md.
--
-- SAFETY
--   * Purely ADDITIVE. One enum, one table with its indexes, and two nullable
--     columns on Event. No existing column is altered, no data is migrated,
--     nothing existing changes behaviour.
--   * Idempotent throughout: IF NOT EXISTS on the table, the columns and the
--     indexes, and a DO block for the enum (CREATE TYPE has no IF NOT EXISTS).
--     A re-run is a no-op.
--   * Blue/green safe: migrations run BEFORE the container swap, and the
--     still-live old container simply never references any of this.
--
-- NOTE ON WHAT IS NOT HERE
--   No amount, no currency, no bank details, no passport, no document table.
--   This record captures eligibility and interest only (decision D1). The
--   money side already exists as SpeakerReimbursement, and duplicating any of
--   it here would create two places to look for the same person's money.
--
--   No backfill either. The feature applies going forward, on events where the
--   organizer enables it (decision D5). Of the 17 upcoming events on the day
--   this was written, 15 held zero submitted abstracts, so enabling the toggle
--   before a call for abstracts opens covers every author with nothing left
--   behind.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TravelGrantStatus') THEN
    CREATE TYPE "TravelGrantStatus" AS ENUM ('PENDING', 'CONSENTED', 'DECLINED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "TravelGrant" (
  "id"               TEXT NOT NULL,
  "eventId"          TEXT NOT NULL,
  "organizationId"   TEXT,
  "speakerId"        TEXT NOT NULL,
  "token"            TEXT NOT NULL,
  "status"           "TravelGrantStatus" NOT NULL DEFAULT 'PENDING',
  "countryAtConsent" TEXT,
  "fullName"         TEXT,
  "institution"      TEXT,
  "termsSnapshot"    TEXT,
  "signedName"       TEXT,
  "submittedAt"      TIMESTAMP(3),
  "submittedIp"      TEXT,
  "invitedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TravelGrant_pkey" PRIMARY KEY ("id")
);

-- The token is the credential in the emailed link, so it must be globally
-- unique. speakerId is globally unique because Speaker is itself event-scoped,
-- which is what makes it equivalent to one-grant-per-person-per-event (D2).
CREATE UNIQUE INDEX IF NOT EXISTS "TravelGrant_token_key"     ON "TravelGrant"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "TravelGrant_speakerId_key" ON "TravelGrant"("speakerId");

CREATE INDEX IF NOT EXISTS "TravelGrant_eventId_status_idx"  ON "TravelGrant"("eventId", "status");
CREATE INDEX IF NOT EXISTS "TravelGrant_organizationId_idx"  ON "TravelGrant"("organizationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TravelGrant_eventId_fkey'
  ) THEN
    ALTER TABLE "TravelGrant"
      ADD CONSTRAINT "TravelGrant_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TravelGrant_speakerId_fkey'
  ) THEN
    ALTER TABLE "TravelGrant"
      ADD CONSTRAINT "TravelGrant_speakerId_fkey"
      FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Two organizer-authored texts on the event, edited under Content -> Abstracts.
-- Two and not one because they answer different questions: the message says why
-- the author is receiving this and renders in the confirmation email; the terms
-- say what they are agreeing to and render on the consent form, where they are
-- snapshotted onto the row.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "travelGrantMessageHtml" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "travelGrantTermsHtml"   TEXT;
