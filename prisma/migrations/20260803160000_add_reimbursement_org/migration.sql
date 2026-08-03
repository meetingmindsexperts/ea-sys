-- Multi-tenancy Phase 2 — Reimbursement domain (Domain #17):
-- SpeakerReimbursement (1-hop from Event) + SpeakerReimbursementDocument
-- (2-hop via SpeakerReimbursement).
-- Additive + idempotent + blue-green safe: nullable organizationId (no FK),
-- backfilled from the owning Event in hop order. The flag-gated RLS policy
-- lives in prisma/rls/reimbursement.sql (harness + platform bootstrap only,
-- never a migration).

-- ---- columns ----
ALTER TABLE "SpeakerReimbursement"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "SpeakerReimbursementDocument" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill: 1-hop from Event ----
UPDATE "SpeakerReimbursement" sr
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE sr."eventId" = e."id" AND sr."organizationId" IS NULL;

-- ---- backfill: 2-hop via the now-stamped SpeakerReimbursement ----
UPDATE "SpeakerReimbursementDocument" doc
SET "organizationId" = sr."organizationId"
FROM "SpeakerReimbursement" sr
WHERE doc."reimbursementId" = sr."id" AND doc."organizationId" IS NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "SpeakerReimbursement_organizationId_idx"         ON "SpeakerReimbursement"("organizationId");
CREATE INDEX IF NOT EXISTS "SpeakerReimbursementDocument_organizationId_idx" ON "SpeakerReimbursementDocument"("organizationId");
