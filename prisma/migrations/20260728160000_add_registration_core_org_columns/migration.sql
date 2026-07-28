-- Multi-tenancy Phase-2 Registration-core sweep (Domain #8): denormalized
-- "organizationId" on the 5 core registration tables, per the ratified
-- FLAT-RLS-policy decision (MULTI_TENANCY_IMPACT.md §8.2 — columns, not join
-- policies). Scope deliberately excludes TicketType/PricingTier/PromoCode
-- (their own follow-up sweep).
--
-- Backfill order: Registration + RegistrationSerialCounter from Event
-- (direct eventId), then Payment + RefundAttempt from Registration (2-hop),
-- then Attendee from its registrations — Attendee has NO event link, so it
-- is stamped ONLY when every one of its registrations agrees on a single
-- org (COUNT(DISTINCT) = 1); orphans (zero registrations) and conflicted
-- rows stay NULL and fail closed under RLS. Additive + idempotent; nullable,
-- no default → metadata-only ALTER, no table rewrite. Old containers during
-- the blue-green window may write NULL rows; writers stamp from this deploy
-- on and the IS NULL predicates make a manual re-run safe. On master
-- (RLS_SET_LOCAL off) the columns are inert; on the greenfield platform DB
-- every row is born stamped.

ALTER TABLE "Registration"              ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "RegistrationSerialCounter" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Payment"                   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "RefundAttempt"             ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Attendee"                  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 1-hop backfills (direct eventId → Event)
UPDATE "Registration" t SET "organizationId" = e."organizationId"
  FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;
UPDATE "RegistrationSerialCounter" t SET "organizationId" = e."organizationId"
  FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

-- 2-hop backfills (via Registration, already backfilled above)
UPDATE "Payment" t SET "organizationId" = r."organizationId"
  FROM "Registration" r WHERE t."registrationId" = r."id" AND t."organizationId" IS NULL;
UPDATE "RefundAttempt" t SET "organizationId" = r."organizationId"
  FROM "Registration" r WHERE t."registrationId" = r."id" AND t."organizationId" IS NULL;

-- Attendee: stamp only rows whose registrations all agree on ONE org.
-- Orphans (no registrations) and cross-org-shared rows (the public-register
-- orphan-reuse race can mint these) stay NULL — invisible under RLS, and the
-- org-bound reuse lookup simply mints a fresh row for them from now on.
UPDATE "Attendee" a SET "organizationId" = sub."org"
  FROM (
    SELECT r."attendeeId" AS aid, MIN(e."organizationId") AS org
    FROM "Registration" r
    JOIN "Event" e ON e."id" = r."eventId"
    GROUP BY r."attendeeId"
    HAVING COUNT(DISTINCT e."organizationId") = 1
  ) sub
  WHERE a."id" = sub.aid AND a."organizationId" IS NULL;

-- Org-leading indexes for the platform's per-tenant queries + RLS
CREATE INDEX IF NOT EXISTS "Registration_organizationId_idx"              ON "Registration"("organizationId");
CREATE INDEX IF NOT EXISTS "RegistrationSerialCounter_organizationId_idx" ON "RegistrationSerialCounter"("organizationId");
CREATE INDEX IF NOT EXISTS "Payment_organizationId_idx"                   ON "Payment"("organizationId");
CREATE INDEX IF NOT EXISTS "RefundAttempt_organizationId_idx"             ON "RefundAttempt"("organizationId");
CREATE INDEX IF NOT EXISTS "Attendee_organizationId_idx"                  ON "Attendee"("organizationId");
