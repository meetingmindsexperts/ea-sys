-- External streams: a partner pushes video to us from their own platform
-- (Nov 12, 2026; docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md, part A step 1).
--
-- A webinar's stream key lives on ZoomMeeting, the row of OUR Zoom webinar. A
-- webinar produced on a partner's platform has no Zoom webinar of ours, so it
-- had nowhere to keep a key. This table is that place: one row per session.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new table; nothing existing is altered,
-- so the old container is never surprised during a blue/green swap. Nothing
-- writes a row until the step that lets staff issue a key, so until then every
-- reader answers exactly as before. Every statement is IF NOT EXISTS or
-- DO-guarded; a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "ExternalStream" (
  "id"              TEXT NOT NULL,
  "sessionId"       TEXT NOT NULL,
  "eventId"         TEXT NOT NULL,
  "organizationId"  TEXT,
  "streamKey"       TEXT NOT NULL,
  "secretVersion"   INTEGER NOT NULL DEFAULT 1,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "validFrom"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil"      TIMESTAMP(3),
  "issuedTo"        TEXT,
  "streamStatus"    "StreamStatus" NOT NULL DEFAULT 'IDLE',
  "lastPublishAt"   TIMESTAMP(3),
  "lastPublisherIp" TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalStream_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalStream_sessionId_key" ON "ExternalStream"("sessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalStream_streamKey_key" ON "ExternalStream"("streamKey");
CREATE INDEX IF NOT EXISTS "ExternalStream_eventId_idx" ON "ExternalStream"("eventId");
CREATE INDEX IF NOT EXISTS "ExternalStream_organizationId_idx" ON "ExternalStream"("organizationId");

DO $$ BEGIN
  ALTER TABLE "ExternalStream" ADD CONSTRAINT "ExternalStream_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ExternalStream" ADD CONSTRAINT "ExternalStream_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- validUntil is nullable: null means "24 hours after the session's scheduled
-- end", read when a publish is checked, so a moved webinar moves its key's
-- period with it. A database that ran the first draft of this file (local
-- development only) has the column NOT NULL; this makes the two agree.
ALTER TABLE "ExternalStream" ALTER COLUMN "validUntil" DROP NOT NULL;
