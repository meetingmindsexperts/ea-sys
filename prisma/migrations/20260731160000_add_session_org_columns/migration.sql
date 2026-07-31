-- Multi-tenancy Phase 2 — Sessions/Tracks domain (Domain #12): Track, EventSession
-- (1-hop from Event) + SessionTopic, SessionSpeaker (2-hop via EventSession) +
-- TopicSpeaker (3-hop via SessionTopic). SessionSpeaker + TopicSpeaker are
-- composite-PK join tables (no own id) — they get a scalar denormalized org column.
-- Additive + idempotent + blue-green safe: nullable organizationId (no FK),
-- backfilled from the owning Event in hop order. The flag-gated RLS policy lives
-- in prisma/rls/session.sql (harness + platform bootstrap only, never a migration).

-- ---- columns ----
ALTER TABLE "Track"          ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "EventSession"   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "SessionTopic"   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "SessionSpeaker" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "TopicSpeaker"   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill: 1-hop from Event ----
UPDATE "Track" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "EventSession" s
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE s."eventId" = e."id" AND s."organizationId" IS NULL;

-- ---- backfill: 2-hop via the now-stamped EventSession ----
UPDATE "SessionTopic" st
SET "organizationId" = s."organizationId"
FROM "EventSession" s
WHERE st."sessionId" = s."id" AND st."organizationId" IS NULL;

UPDATE "SessionSpeaker" ss
SET "organizationId" = s."organizationId"
FROM "EventSession" s
WHERE ss."sessionId" = s."id" AND ss."organizationId" IS NULL;

-- ---- backfill: 3-hop via the now-stamped SessionTopic ----
UPDATE "TopicSpeaker" ts
SET "organizationId" = st."organizationId"
FROM "SessionTopic" st
WHERE ts."topicId" = st."id" AND ts."organizationId" IS NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "Track_organizationId_idx"          ON "Track"("organizationId");
CREATE INDEX IF NOT EXISTS "EventSession_organizationId_idx"   ON "EventSession"("organizationId");
CREATE INDEX IF NOT EXISTS "SessionTopic_organizationId_idx"   ON "SessionTopic"("organizationId");
CREATE INDEX IF NOT EXISTS "SessionSpeaker_organizationId_idx" ON "SessionSpeaker"("organizationId");
CREATE INDEX IF NOT EXISTS "TopicSpeaker_organizationId_idx"   ON "TopicSpeaker"("organizationId");
