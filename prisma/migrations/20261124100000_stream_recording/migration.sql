-- Recording a partner's stream (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md,
-- step 1). The stream server writes a partner's stream in pieces of about six
-- seconds, the worker ships each piece to S3, and one MP4 is made at the end.
-- StreamRecording is the recording (one per session); StreamRecordingSegment is
-- one shipped piece.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new enum and two new tables; nothing
-- existing is altered, so the container still running the previous image is
-- never surprised during a blue/green swap. Nothing writes a row until
-- STREAM_RECORDING_ENABLED is set on the server, so until then every reader
-- answers exactly as before. Every statement is IF NOT EXISTS or DO-guarded; a
-- re-run is a no-op.
SET lock_timeout = '10s';

DO $$ BEGIN
  CREATE TYPE "StreamRecordingStatus" AS ENUM ('RECORDING', 'PAUSED', 'FINISHING', 'READY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StreamRecording" (
  "id"                    TEXT NOT NULL,
  "sessionId"             TEXT NOT NULL,
  "eventId"               TEXT NOT NULL,
  "organizationId"        TEXT,
  "status"                "StreamRecordingStatus" NOT NULL DEFAULT 'RECORDING',
  "partnerAgreedAt"       TIMESTAMP(3) NOT NULL,
  "partnerAgreedByUserId" TEXT,
  "startedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedByUserId"       TEXT,
  "lastStartedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stoppedAt"             TIMESTAMP(3),
  "finishedAt"            TIMESTAMP(3),
  "storagePrefix"         TEXT NOT NULL,
  "segmentCount"          INTEGER NOT NULL DEFAULT 0,
  "totalBytes"            BIGINT NOT NULL DEFAULT 0,
  "durationMs"            INTEGER NOT NULL DEFAULT 0,
  "archivePath"           TEXT,
  "archiveBytes"          BIGINT,
  "error"                 TEXT,
  "deleteAfter"           TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StreamRecording_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StreamRecording_sessionId_key" ON "StreamRecording"("sessionId");
CREATE INDEX IF NOT EXISTS "StreamRecording_eventId_idx" ON "StreamRecording"("eventId");
CREATE INDEX IF NOT EXISTS "StreamRecording_organizationId_idx" ON "StreamRecording"("organizationId");
CREATE INDEX IF NOT EXISTS "StreamRecording_status_idx" ON "StreamRecording"("status");

DO $$ BEGIN
  ALTER TABLE "StreamRecording" ADD CONSTRAINT "StreamRecording_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StreamRecording" ADD CONSTRAINT "StreamRecording_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StreamRecordingSegment" (
  "id"             TEXT NOT NULL,
  "recordingId"    TEXT NOT NULL,
  "organizationId" TEXT,
  "seq"            INTEGER NOT NULL,
  "sourceName"     TEXT NOT NULL,
  "startedAt"      TIMESTAMP(3) NOT NULL,
  "durationMs"     INTEGER NOT NULL,
  "bytes"          INTEGER NOT NULL,
  "storedPath"     TEXT NOT NULL,
  "afterBreak"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StreamRecordingSegment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StreamRecordingSegment_recordingId_seq_key" ON "StreamRecordingSegment"("recordingId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "StreamRecordingSegment_recordingId_sourceName_key" ON "StreamRecordingSegment"("recordingId", "sourceName");
CREATE INDEX IF NOT EXISTS "StreamRecordingSegment_organizationId_idx" ON "StreamRecordingSegment"("organizationId");

DO $$ BEGIN
  ALTER TABLE "StreamRecordingSegment" ADD CONSTRAINT "StreamRecordingSegment_recordingId_fkey"
    FOREIGN KEY ("recordingId") REFERENCES "StreamRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
