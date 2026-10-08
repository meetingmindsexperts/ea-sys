-- Online venue (Oct 8, 2026; docs/EVENT_BLUEPRINT_PLAN.md phase 4): one
-- activity row per person per event, and append-only safety reports.
-- Additive and idempotent: two new tables, nothing existing touched. RLS
-- policies are in prisma/rls/venue.sql (platform instance only).


CREATE TABLE IF NOT EXISTS "VenueActivity" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VenueReport" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VenueActivity_organizationId_idx" ON "VenueActivity"("organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "VenueActivity_eventId_userId_key" ON "VenueActivity"("eventId", "userId");

CREATE INDEX IF NOT EXISTS "VenueReport_eventId_createdAt_idx" ON "VenueReport"("eventId", "createdAt");

CREATE INDEX IF NOT EXISTS "VenueReport_organizationId_idx" ON "VenueReport"("organizationId");

DO $$ BEGIN
  ALTER TABLE "VenueActivity" ADD CONSTRAINT "VenueActivity_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "VenueActivity" ADD CONSTRAINT "VenueActivity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "VenueReport" ADD CONSTRAINT "VenueReport_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "VenueReport" ADD CONSTRAINT "VenueReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
