-- Add lastAttendanceSyncAt to ZoomMeeting (used by attendance cron eligibility)
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "lastAttendanceSyncAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ZoomMeeting_lastAttendanceSyncAt_idx" ON "ZoomMeeting"("lastAttendanceSyncAt");

-- ZoomAttendance: per-attendee join/leave records pulled from Zoom's participant report
CREATE TABLE IF NOT EXISTS "ZoomAttendance" (
  "id" TEXT NOT NULL,
  "zoomMeetingId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "registrationId" TEXT,
  "zoomParticipantId" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "joinTime" TIMESTAMP(3) NOT NULL,
  "leaveTime" TIMESTAMP(3),
  "durationSeconds" INTEGER NOT NULL,
  "attentivenessScore" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ZoomAttendance_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "ZoomAttendance" ADD CONSTRAINT "ZoomAttendance_zoomMeetingId_fkey"
    FOREIGN KEY ("zoomMeetingId") REFERENCES "ZoomMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ZoomAttendance" ADD CONSTRAINT "ZoomAttendance_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ZoomAttendance" ADD CONSTRAINT "ZoomAttendance_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ZoomAttendance" ADD CONSTRAINT "ZoomAttendance_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "ZoomAttendance_zoomMeetingId_zoomParticipantId_joinTime_key"
  ON "ZoomAttendance"("zoomMeetingId", "zoomParticipantId", "joinTime");
CREATE INDEX IF NOT EXISTS "ZoomAttendance_zoomMeetingId_idx" ON "ZoomAttendance"("zoomMeetingId");
CREATE INDEX IF NOT EXISTS "ZoomAttendance_eventId_sessionId_idx" ON "ZoomAttendance"("eventId", "sessionId");
CREATE INDEX IF NOT EXISTS "ZoomAttendance_email_idx" ON "ZoomAttendance"("email");
CREATE INDEX IF NOT EXISTS "ZoomAttendance_registrationId_idx" ON "ZoomAttendance"("registrationId");
