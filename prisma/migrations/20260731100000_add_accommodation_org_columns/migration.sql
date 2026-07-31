-- Multi-tenancy Phase 2 — Accommodation domain (Hotel / RoomType / Accommodation).
-- Additive + idempotent + blue-green safe: nullable denormalized organizationId
-- (no FK) on each of the 3 tables, backfilled from the parent Event. Writers stamp
-- from this deploy forward; the flag-gated RLS policy (prisma/rls/accommodation.sql)
-- is applied ONLY by the tenancy harness + the future platform bootstrap, never here.

-- ---- columns ----
ALTER TABLE "Hotel"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "RoomType"      ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Accommodation" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill ----
-- Hotel: 1-hop from its Event. Every Hotel row has a non-null eventId.
UPDATE "Hotel" h
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE h."eventId" = e."id" AND h."organizationId" IS NULL;

-- RoomType: 2-hop via the now-stamped Hotel.
UPDATE "RoomType" rt
SET "organizationId" = h."organizationId"
FROM "Hotel" h
WHERE rt."hotelId" = h."id" AND rt."organizationId" IS NULL;

-- Accommodation: 1-hop from its Event. Every Accommodation row has a non-null eventId.
UPDATE "Accommodation" a
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE a."eventId" = e."id" AND a."organizationId" IS NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "Hotel_organizationId_idx"         ON "Hotel"("organizationId");
CREATE INDEX IF NOT EXISTS "RoomType_organizationId_idx"      ON "RoomType"("organizationId");
CREATE INDEX IF NOT EXISTS "Accommodation_organizationId_idx" ON "Accommodation"("organizationId");
