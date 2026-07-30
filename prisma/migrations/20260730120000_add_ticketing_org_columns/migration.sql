-- Multi-tenancy Phase 2 — ticketing follow-on (Domain #8 carve-off).
-- Denormalize organizationId onto the 5 ticketing tables (TicketType,
-- PricingTier, PromoCode, PromoCodeRedemption, PromoCodeTicketType), backfilled
-- from the owning Event. Additive + idempotent (nullable column, no FK, no table
-- rewrite) → blue-green safe. Writers stamp the column from this deploy on; RLS
-- policies are applied ONLY by the tenancy harness + the future platform
-- bootstrap, never by a migration, so master keeps a policy-free DB.

-- ── 1. Add columns (idempotent) ──────────────────────────────────────
ALTER TABLE "TicketType"          ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "PricingTier"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "PromoCode"           ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "PromoCodeRedemption" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "PromoCodeTicketType" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ── 2. Backfill in dependency order ──────────────────────────────────
-- 1-hop from Event.
UPDATE "TicketType" tt
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE tt."eventId" = e."id" AND tt."organizationId" IS NULL;

UPDATE "PromoCode" pc
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE pc."eventId" = e."id" AND pc."organizationId" IS NULL;

-- 2-hop via the now-stamped parents.
UPDATE "PricingTier" pt
SET "organizationId" = tt."organizationId"
FROM "TicketType" tt
WHERE pt."ticketTypeId" = tt."id" AND pt."organizationId" IS NULL;

UPDATE "PromoCodeRedemption" pr
SET "organizationId" = pc."organizationId"
FROM "PromoCode" pc
WHERE pr."promoCodeId" = pc."id" AND pr."organizationId" IS NULL;

UPDATE "PromoCodeTicketType" pl
SET "organizationId" = pc."organizationId"
FROM "PromoCode" pc
WHERE pl."promoCodeId" = pc."id" AND pl."organizationId" IS NULL;

-- ── 3. Indexes (idempotent) ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "TicketType_organizationId_idx"          ON "TicketType"("organizationId");
CREATE INDEX IF NOT EXISTS "PricingTier_organizationId_idx"         ON "PricingTier"("organizationId");
CREATE INDEX IF NOT EXISTS "PromoCode_organizationId_idx"           ON "PromoCode"("organizationId");
CREATE INDEX IF NOT EXISTS "PromoCodeRedemption_organizationId_idx" ON "PromoCodeRedemption"("organizationId");
CREATE INDEX IF NOT EXISTS "PromoCodeTicketType_organizationId_idx" ON "PromoCodeTicketType"("organizationId");
