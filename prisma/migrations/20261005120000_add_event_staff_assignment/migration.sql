-- Custom roles Phase 4: assigned event staff as rows, not settings JSON.
--
-- An ASSIGNED-scope grant (today the ONSITE desk) reaches only the events a
-- person is assigned to. That list lived in Event.settings.onsiteUserIds, a
-- JSON array with no foreign key: deleting a user left their id behind, and
-- nothing could index or join it. This table replaces it.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new table; nothing existing is altered,
-- so the old container is never surprised during a blue/green swap. The JSON
-- stays written (src/lib/event-staff.ts) and the access checks read either for
-- one release, so a rollback strands nothing. Every statement is IF NOT EXISTS
-- or DO-guarded, and the backfill is ON CONFLICT DO NOTHING, so a re-run is a
-- no-op.

CREATE TABLE IF NOT EXISTS "EventStaffAssignment" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "assignedById"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventStaffAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EventStaffAssignment_eventId_userId_key"
  ON "EventStaffAssignment"("eventId", "userId");
CREATE INDEX IF NOT EXISTS "EventStaffAssignment_userId_idx"
  ON "EventStaffAssignment"("userId");
CREATE INDEX IF NOT EXISTS "EventStaffAssignment_organizationId_idx"
  ON "EventStaffAssignment"("organizationId");

DO $$ BEGIN
  ALTER TABLE "EventStaffAssignment" ADD CONSTRAINT "EventStaffAssignment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EventStaffAssignment" ADD CONSTRAINT "EventStaffAssignment_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EventStaffAssignment" ADD CONSTRAINT "EventStaffAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill from the JSON. Only ids that are real users in the event's own
-- organisation: a stale id (a deleted user) or a foreign one is dropped here,
-- which is the litter the JSON could never shed. The id is derived, so a
-- re-run inserts nothing new.
INSERT INTO "EventStaffAssignment" ("id", "organizationId", "eventId", "userId", "createdAt")
SELECT 'esa_' || md5(e."id" || ':' || u."id"), e."organizationId", e."id", u."id", CURRENT_TIMESTAMP
FROM "Event" e
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(e."settings"::jsonb -> 'onsiteUserIds') = 'array'
       THEN e."settings"::jsonb -> 'onsiteUserIds' ELSE '[]'::jsonb END
) AS staff("userId")
JOIN "User" u ON u."id" = staff."userId" AND u."organizationId" = e."organizationId"
ON CONFLICT ("eventId", "userId") DO NOTHING;
