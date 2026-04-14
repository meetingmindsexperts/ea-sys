-- Add lastEngagementSyncAt to ZoomMeeting
ALTER TABLE "ZoomMeeting" ADD COLUMN IF NOT EXISTS "lastEngagementSyncAt" TIMESTAMP(3);

-- WebinarPoll: poll definitions from Zoom's report
CREATE TABLE IF NOT EXISTS "WebinarPoll" (
  "id" TEXT NOT NULL,
  "zoomMeetingId" TEXT NOT NULL,
  "zoomPollId" TEXT,
  "title" TEXT NOT NULL,
  "questions" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebinarPoll_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "WebinarPoll" ADD CONSTRAINT "WebinarPoll_zoomMeetingId_fkey"
    FOREIGN KEY ("zoomMeetingId") REFERENCES "ZoomMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "WebinarPoll_zoomMeetingId_zoomPollId_key"
  ON "WebinarPoll"("zoomMeetingId", "zoomPollId");
CREATE INDEX IF NOT EXISTS "WebinarPoll_zoomMeetingId_idx" ON "WebinarPoll"("zoomMeetingId");

-- WebinarPollResponse: one row per participant per poll submission
CREATE TABLE IF NOT EXISTS "WebinarPollResponse" (
  "id" TEXT NOT NULL,
  "pollId" TEXT NOT NULL,
  "participantName" TEXT NOT NULL,
  "participantEmail" TEXT,
  "answers" JSONB NOT NULL DEFAULT '{}',
  "submittedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebinarPollResponse_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "WebinarPollResponse" ADD CONSTRAINT "WebinarPollResponse_pollId_fkey"
    FOREIGN KEY ("pollId") REFERENCES "WebinarPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "WebinarPollResponse_pollId_idx" ON "WebinarPollResponse"("pollId");

-- WebinarQuestion: Q&A from Zoom's report
CREATE TABLE IF NOT EXISTS "WebinarQuestion" (
  "id" TEXT NOT NULL,
  "zoomMeetingId" TEXT NOT NULL,
  "askerName" TEXT NOT NULL,
  "askerEmail" TEXT,
  "question" TEXT NOT NULL,
  "answer" TEXT,
  "answeredByName" TEXT,
  "askedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebinarQuestion_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "WebinarQuestion" ADD CONSTRAINT "WebinarQuestion_zoomMeetingId_fkey"
    FOREIGN KEY ("zoomMeetingId") REFERENCES "ZoomMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "WebinarQuestion_zoomMeetingId_askerName_askedAt_key"
  ON "WebinarQuestion"("zoomMeetingId", "askerName", "askedAt");
CREATE INDEX IF NOT EXISTS "WebinarQuestion_zoomMeetingId_idx" ON "WebinarQuestion"("zoomMeetingId");
