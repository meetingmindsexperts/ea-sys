-- Add SessionRole enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SessionRole') THEN
    CREATE TYPE "SessionRole" AS ENUM ('SPEAKER', 'MODERATOR', 'CHAIRPERSON', 'PANELIST');
  END IF;
END $$;

-- Create SessionTopic table
CREATE TABLE IF NOT EXISTS "SessionTopic" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "abstractId" TEXT,
  "title" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "duration" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SessionTopic_pkey" PRIMARY KEY ("id")
);

-- Create TopicSpeaker table
CREATE TABLE IF NOT EXISTS "TopicSpeaker" (
  "topicId" TEXT NOT NULL,
  "speakerId" TEXT NOT NULL,
  CONSTRAINT "TopicSpeaker_pkey" PRIMARY KEY ("topicId", "speakerId")
);

-- Add foreign keys for SessionTopic
ALTER TABLE "SessionTopic" ADD CONSTRAINT "SessionTopic_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  ALTER TABLE "SessionTopic" ADD CONSTRAINT "SessionTopic_abstractId_fkey"
    FOREIGN KEY ("abstractId") REFERENCES "Abstract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add foreign keys for TopicSpeaker
ALTER TABLE "TopicSpeaker" ADD CONSTRAINT "TopicSpeaker_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "SessionTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TopicSpeaker" ADD CONSTRAINT "TopicSpeaker_speakerId_fkey"
  FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique index on SessionTopic.abstractId
CREATE UNIQUE INDEX IF NOT EXISTS "SessionTopic_abstractId_key" ON "SessionTopic"("abstractId");

-- Index on SessionTopic.sessionId
CREATE INDEX IF NOT EXISTS "SessionTopic_sessionId_idx" ON "SessionTopic"("sessionId");

-- Migrate SessionSpeaker.role from String to SessionRole enum
-- First, convert existing "speaker" values to "SPEAKER" (enum value)
UPDATE "SessionSpeaker" SET "role" = 'SPEAKER' WHERE "role" = 'speaker';
UPDATE "SessionSpeaker" SET "role" = 'MODERATOR' WHERE "role" = 'moderator';
UPDATE "SessionSpeaker" SET "role" = 'CHAIRPERSON' WHERE "role" = 'chairperson';
UPDATE "SessionSpeaker" SET "role" = 'PANELIST' WHERE "role" = 'panelist';

-- Alter column type from text to enum
ALTER TABLE "SessionSpeaker" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "SessionSpeaker" ALTER COLUMN "role" TYPE "SessionRole" USING "role"::"SessionRole";
ALTER TABLE "SessionSpeaker" ALTER COLUMN "role" SET DEFAULT 'SPEAKER';
