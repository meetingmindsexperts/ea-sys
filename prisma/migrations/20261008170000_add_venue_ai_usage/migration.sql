-- Online venue, phase 5 (Oct 8, 2026; docs/EVENT_BLUEPRINT_PLAN.md §5.4a): AI
-- attendee replies per event per day, the daily cap's counter. Additive and
-- idempotent: one new table, nothing existing touched. RLS policy in
-- prisma/rls/venue.sql (platform instance only).

CREATE TABLE IF NOT EXISTS "VenueAiUsage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueAiUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VenueAiUsage_eventId_day_key" ON "VenueAiUsage"("eventId", "day");

CREATE INDEX IF NOT EXISTS "VenueAiUsage_organizationId_idx" ON "VenueAiUsage"("organizationId");

DO $$ BEGIN
  ALTER TABLE "VenueAiUsage" ADD CONSTRAINT "VenueAiUsage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "VenueAiUsage" ADD CONSTRAINT "VenueAiUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
