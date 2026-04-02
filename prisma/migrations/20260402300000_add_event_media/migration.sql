-- Add eventId to MediaFile for event-scoped media
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "eventId" TEXT;

-- Foreign key: MediaFile.eventId → Event.id (CASCADE delete)
DO $$ BEGIN
    ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_eventId_fkey"
        FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Index for event-scoped queries
CREATE INDEX IF NOT EXISTS "MediaFile_eventId_idx" ON "MediaFile"("eventId");
