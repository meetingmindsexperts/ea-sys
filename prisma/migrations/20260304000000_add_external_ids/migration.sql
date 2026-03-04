-- Migration: add_external_ids
-- Adds externalId and externalSource fields for EventsAir import deduplication.
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

-- Event: externalId + externalSource for tracking imported events
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "externalSource" TEXT;
CREATE INDEX IF NOT EXISTS "Event_externalSource_externalId_idx" ON "Event"("externalSource", "externalId");

-- Attendee: externalId for tracking imported contacts
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- Speaker: externalId for tracking imported speakers
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- EventSession: externalId for tracking imported sessions
ALTER TABLE "EventSession" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
