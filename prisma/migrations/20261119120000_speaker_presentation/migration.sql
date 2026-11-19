-- Speaker presentations: slides or a video a speaker gives us for a talk
-- (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md).
--
-- The files are too large for the app (nginx refuses a body over 10 MB), so
-- the browser uploads straight to storage and this table holds the row that
-- tracks each one: UPLOADING until the object is checked, then READY.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new enum and one new table; nothing
-- existing is altered, so the old container is never surprised during a
-- blue/green swap, and nothing writes a row until the new image runs. Every
-- statement is IF NOT EXISTS or DO-guarded; a re-run is a no-op.

SET lock_timeout = '10s';

DO $$ BEGIN
  CREATE TYPE "PresentationStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED', 'REPLACED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SpeakerPresentation" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "organizationId" TEXT,
  "speakerId"      TEXT NOT NULL,
  "sessionId"      TEXT,
  "topicId"        TEXT,
  "url"            TEXT NOT NULL,
  "s3VersionId"    TEXT,
  "etag"           TEXT,
  "filename"       TEXT NOT NULL,
  "mimeType"       TEXT NOT NULL,
  "size"           BIGINT,
  "status"         "PresentationStatus" NOT NULL DEFAULT 'UPLOADING',
  "uploadedVia"    TEXT NOT NULL,
  "uploadedById"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt"        TIMESTAMP(3),
  CONSTRAINT "SpeakerPresentation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SpeakerPresentation_eventId_status_idx" ON "SpeakerPresentation"("eventId", "status");
CREATE INDEX IF NOT EXISTS "SpeakerPresentation_speakerId_idx" ON "SpeakerPresentation"("speakerId");
CREATE INDEX IF NOT EXISTS "SpeakerPresentation_organizationId_idx" ON "SpeakerPresentation"("organizationId");

DO $$ BEGIN
  ALTER TABLE "SpeakerPresentation" ADD CONSTRAINT "SpeakerPresentation_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerPresentation" ADD CONSTRAINT "SpeakerPresentation_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerPresentation" ADD CONSTRAINT "SpeakerPresentation_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerPresentation" ADD CONSTRAINT "SpeakerPresentation_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "SessionTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
