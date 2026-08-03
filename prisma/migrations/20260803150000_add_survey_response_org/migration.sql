-- Multi-tenancy Phase 2 — Survey domain (Domain #16): SurveyResponse
-- (1-hop from Event — the table carries its own eventId).
-- Additive + idempotent + blue-green safe: nullable organizationId (no FK),
-- backfilled from the owning Event. The flag-gated RLS policy lives in
-- prisma/rls/survey.sql (harness + platform bootstrap only, never a migration).

-- ---- column ----
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill: 1-hop from Event ----
UPDATE "SurveyResponse" sr
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE sr."eventId" = e."id" AND sr."organizationId" IS NULL;

-- ---- index ----
CREATE INDEX IF NOT EXISTS "SurveyResponse_organizationId_idx" ON "SurveyResponse"("organizationId");
