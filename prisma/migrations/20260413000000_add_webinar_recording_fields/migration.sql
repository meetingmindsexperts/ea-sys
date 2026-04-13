-- RecordingStatus enum
DO $$ BEGIN CREATE TYPE "RecordingStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'AVAILABLE', 'FAILED', 'EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add recording fields to ZoomMeeting
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingUrl" TEXT;
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingPassword" TEXT;
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingDownloadUrl" TEXT;
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingDuration" INTEGER;
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingFetchedAt" TIMESTAMP(3);
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "recordingStatus" "RecordingStatus" NOT NULL DEFAULT 'NOT_REQUESTED';

-- Index for cron worker queries filtered by recording status
CREATE INDEX IF NOT EXISTS "ZoomMeeting_recordingStatus_idx" ON "ZoomMeeting"("recordingStatus");
