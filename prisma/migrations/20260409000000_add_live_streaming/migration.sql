-- StreamStatus enum
DO $$ BEGIN CREATE TYPE "StreamStatus" AS ENUM ('IDLE', 'ACTIVE', 'ENDED', 'ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add live streaming fields to ZoomMeeting
ALTER TABLE "ZoomMeeting" ADD COLUMN "liveStreamEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ZoomMeeting" ADD COLUMN "streamKey" TEXT;
ALTER TABLE "ZoomMeeting" ADD COLUMN "streamStatus" "StreamStatus" NOT NULL DEFAULT 'IDLE';
