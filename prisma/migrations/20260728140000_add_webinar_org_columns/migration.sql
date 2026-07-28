-- Multi-tenancy Phase-2 Webinar/Zoom sweep (Domain #6): denormalized
-- "organizationId" on the 6 webinar tables, per the ratified FLAT-RLS-policy
-- decision (MULTI_TENANCY_IMPACT.md §8.2 — columns, not join policies).
--
-- Backfill order matters: ZoomMeeting first (from Event), then the 2-hop
-- tables (from ZoomMeeting), then the 3-hop WebinarPollResponse (from
-- WebinarPoll). Additive + idempotent; nullable, no default → metadata-only
-- ALTER, no table rewrite. Old containers during the blue-green window may
-- write rows with NULL organizationId; writers stamp it from this deploy on,
-- the sync state machines re-stamp on their update paths (self-healing), and
-- the backfill predicate (IS NULL) makes a manual re-run safe if ever needed.
-- On master (RLS_SET_LOCAL off) the column is inert; on the greenfield
-- platform DB every row is born stamped.

-- 1-hop tables (direct eventId)
ALTER TABLE "ZoomMeeting"     ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "ZoomAttendance"  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

UPDATE "ZoomMeeting" t SET "organizationId" = e."organizationId"
  FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;
UPDATE "ZoomAttendance" t SET "organizationId" = e."organizationId"
  FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;
UPDATE "WebinarPresence" t SET "organizationId" = e."organizationId"
  FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

-- 2-hop tables (via ZoomMeeting, already backfilled above)
ALTER TABLE "WebinarPoll"     ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "WebinarQuestion" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

UPDATE "WebinarPoll" t SET "organizationId" = zm."organizationId"
  FROM "ZoomMeeting" zm WHERE t."zoomMeetingId" = zm."id" AND t."organizationId" IS NULL;
UPDATE "WebinarQuestion" t SET "organizationId" = zm."organizationId"
  FROM "ZoomMeeting" zm WHERE t."zoomMeetingId" = zm."id" AND t."organizationId" IS NULL;

-- 3-hop table (via WebinarPoll, already backfilled above)
ALTER TABLE "WebinarPollResponse" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

UPDATE "WebinarPollResponse" t SET "organizationId" = wp."organizationId"
  FROM "WebinarPoll" wp WHERE t."pollId" = wp."id" AND t."organizationId" IS NULL;

-- Org-leading indexes for the platform's per-tenant queries + RLS
CREATE INDEX IF NOT EXISTS "ZoomMeeting_organizationId_idx"         ON "ZoomMeeting"("organizationId");
CREATE INDEX IF NOT EXISTS "ZoomAttendance_organizationId_idx"      ON "ZoomAttendance"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarPresence_organizationId_idx"     ON "WebinarPresence"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarPoll_organizationId_idx"         ON "WebinarPoll"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarQuestion_organizationId_idx"     ON "WebinarQuestion"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarPollResponse_organizationId_idx" ON "WebinarPollResponse"("organizationId");
