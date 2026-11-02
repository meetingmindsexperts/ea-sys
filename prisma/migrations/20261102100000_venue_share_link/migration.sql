-- The exhibitor floor plan link (Nov 2, 2026; docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md
-- section 10): one secret, read-only link per event. Additive and idempotent: one
-- new table, nothing existing touched.
CREATE TABLE IF NOT EXISTS "VenueShareLink" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VenueShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VenueShareLink_eventId_key" ON "VenueShareLink"("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "VenueShareLink_token_key" ON "VenueShareLink"("token");
CREATE INDEX IF NOT EXISTS "VenueShareLink_organizationId_idx" ON "VenueShareLink"("organizationId");

DO $$ BEGIN
  ALTER TABLE "VenueShareLink" ADD CONSTRAINT "VenueShareLink_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
