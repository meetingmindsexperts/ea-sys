-- Accommodation: make registrationId optional, add speakerId
ALTER TABLE "Accommodation" ALTER COLUMN "registrationId" DROP NOT NULL;
ALTER TABLE "Accommodation" ADD COLUMN "speakerId" TEXT;
CREATE UNIQUE INDEX "Accommodation_speakerId_key" ON "Accommodation"("speakerId");
ALTER TABLE "Accommodation" ADD CONSTRAINT "Accommodation_speakerId_fkey"
  FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ZoomMeeting enums
DO $$ BEGIN CREATE TYPE "ZoomMeetingType" AS ENUM ('MEETING', 'WEBINAR', 'WEBINAR_SERIES'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ZoomMeetingStatus" AS ENUM ('CREATED', 'STARTED', 'ENDED', 'DELETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ZoomMeeting table
CREATE TABLE "ZoomMeeting" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "zoomMeetingId" TEXT NOT NULL,
    "meetingType" "ZoomMeetingType" NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "startUrl" TEXT,
    "passcode" TEXT,
    "duration" INTEGER,
    "status" "ZoomMeetingStatus" NOT NULL DEFAULT 'CREATED',
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceType" INTEGER,
    "occurrences" JSONB,
    "zoomResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZoomMeeting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZoomMeeting_sessionId_key" ON "ZoomMeeting"("sessionId");
CREATE INDEX "ZoomMeeting_eventId_idx" ON "ZoomMeeting"("eventId");
CREATE INDEX "ZoomMeeting_zoomMeetingId_idx" ON "ZoomMeeting"("zoomMeetingId");

ALTER TABLE "ZoomMeeting" ADD CONSTRAINT "ZoomMeeting_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZoomMeeting" ADD CONSTRAINT "ZoomMeeting_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
