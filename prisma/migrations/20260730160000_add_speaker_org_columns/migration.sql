-- Multi-tenancy Phase 2 — Speaker domain sweep.
-- Denormalize organizationId onto Speaker + SpeakerDocument, backfilled from the
-- owning Event. Additive + idempotent (nullable column, no FK, no table rewrite)
-- → blue-green safe. Writers stamp the column from this deploy on; RLS policies
-- are applied ONLY by the tenancy harness + the future platform bootstrap, never
-- by a migration, so master keeps a policy-free DB.
--
-- Speaker is the CLEAN case: every row has eventId (no orphans), so the 1-hop
-- backfill is 100%. SpeakerDocument is 2-hop via speakerId → Speaker.

-- ── 1. Add columns (idempotent) ──────────────────────────────────────
ALTER TABLE "Speaker"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "SpeakerDocument" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ── 2. Backfill in dependency order ──────────────────────────────────
-- 1-hop from Event.
UPDATE "Speaker" s
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE s."eventId" = e."id" AND s."organizationId" IS NULL;

-- 2-hop via the now-stamped Speaker.
UPDATE "SpeakerDocument" sd
SET "organizationId" = s."organizationId"
FROM "Speaker" s
WHERE sd."speakerId" = s."id" AND sd."organizationId" IS NULL;

-- ── 3. Indexes (idempotent) ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Speaker_organizationId_idx"         ON "Speaker"("organizationId");
CREATE INDEX IF NOT EXISTS "SpeakerDocument_organizationId_idx" ON "SpeakerDocument"("organizationId");
