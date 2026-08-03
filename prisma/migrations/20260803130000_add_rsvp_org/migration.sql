-- Multi-tenancy Phase-2 sweep, Domain #15 — Dinner RSVP.
-- Adds a denormalized nullable organizationId (scalar + index, no FK) to the
-- three RSVP tables and backfills it: RsvpDinner + RsvpInvite 1-hop from Event,
-- RsvpDinnerResponse 2-hop via RsvpInvite. Additive + idempotent (ADD COLUMN
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / backfill guarded on NULL), so it
-- is blue-green safe: the old container keeps writing NULL org (harmless — RLS
-- is off on master), the new container stamps org at every create site, and
-- this backfill closes any rows the deploy window left NULL. Drives the RLS
-- policies in prisma/rls/rsvp.sql (applied by the harness + platform bootstrap
-- ONLY, never here).

-- RsvpDinner: org from Event (1-hop).
ALTER TABLE "RsvpDinner" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "RsvpDinner" d
  SET "organizationId" = e."organizationId"
  FROM "Event" e
  WHERE d."eventId" = e."id" AND d."organizationId" IS NULL;
CREATE INDEX IF NOT EXISTS "RsvpDinner_organizationId_idx" ON "RsvpDinner" ("organizationId");

-- RsvpInvite: org from Event (1-hop).
ALTER TABLE "RsvpInvite" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "RsvpInvite" i
  SET "organizationId" = e."organizationId"
  FROM "Event" e
  WHERE i."eventId" = e."id" AND i."organizationId" IS NULL;
CREATE INDEX IF NOT EXISTS "RsvpInvite_organizationId_idx" ON "RsvpInvite" ("organizationId");

-- RsvpDinnerResponse: org from RsvpInvite (2-hop; runs after the invite backfill
-- above so the parent's org is already populated).
ALTER TABLE "RsvpDinnerResponse" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "RsvpDinnerResponse" r
  SET "organizationId" = i."organizationId"
  FROM "RsvpInvite" i
  WHERE r."inviteId" = i."id" AND r."organizationId" IS NULL;
CREATE INDEX IF NOT EXISTS "RsvpDinnerResponse_organizationId_idx" ON "RsvpDinnerResponse" ("organizationId");
