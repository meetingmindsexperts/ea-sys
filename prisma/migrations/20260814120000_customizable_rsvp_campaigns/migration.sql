-- Customizable RSVP: introduce RsvpCampaign so ONE event can run SEVERAL
-- independent RSVPs, each with its own items AND its own audience.
--
-- Before this, RsvpInvite was event-level with @@unique([eventId, inviteeEmail]),
-- so a 30-person dinner list and a 200-person workshop list could not coexist:
-- the second add collided with the first, and reusing the invite would have shown
-- the workshop audience the VIP dinner list.
--
-- SAFETY
--   * NO table renames. The Prisma models were renamed (RsvpDinner -> RsvpItem,
--     RsvpDinnerResponse -> RsvpResponse) via @@map, so the physical tables are
--     untouched. `prisma migrate deploy` runs BEFORE the blue/green container
--     swap, so a real ALTER TABLE ... RENAME would leave the still-live old
--     container querying a table that no longer exists.
--   * Idempotent throughout: IF NOT EXISTS / IF EXISTS / duplicate_object traps,
--     and a DETERMINISTIC campaign id so the backfill can be re-run.
--   * NOT purely additive, in full: two SET NOT NULL (step 9) and two DROP
--     INDEX (step 12 = the load-bearing unique swap; step 13 = a superseded
--     performance index). Step 12 is the only one that can change behaviour;
--     the rest are noted where they appear. An earlier version of this header
--     said "ONE", which understated it.
--
-- Verified read-only against prod before writing (2026-08-14):
--     RsvpDinner 1 · RsvpInvite 2 · RsvpDinnerResponse 0 · events with dinners 1
-- i.e. the feature is effectively unused, which is what makes step 12 and the
-- SET NOT NULL in step 9 safe here. See docs/CUSTOMIZABLE_RSVP_PLAN.md §7.

-- 1. Selection mode ---------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "RsvpSelectionMode" AS ENUM ('SINGLE', 'MULTI');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. The campaign table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS "RsvpCampaign" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "organizationId" TEXT,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "selectionMode"  "RsvpSelectionMode" NOT NULL DEFAULT 'MULTI',
  "allowGuests"    BOOLEAN NOT NULL DEFAULT false,
  "collectDietary" BOOLEAN NOT NULL DEFAULT false,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RsvpCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RsvpCampaign_eventId_idx" ON "RsvpCampaign"("eventId");
CREATE INDEX IF NOT EXISTS "RsvpCampaign_organizationId_idx" ON "RsvpCampaign"("organizationId");

DO $$ BEGIN
  ALTER TABLE "RsvpCampaign"
    ADD CONSTRAINT "RsvpCampaign_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3-4. campaignId columns (nullable first, so the backfill can fill them) ----
ALTER TABLE "RsvpDinner" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
ALTER TABLE "RsvpInvite" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;

-- 5. Backfill: ONE campaign per event that holds any RSVP data today.
--    Deterministic id => re-running this migration is a clean no-op.
--    Defaults reproduce today's EXACT behavior (tick any night, guests on,
--    dietary collected), so nothing an organizer already set up changes.
INSERT INTO "RsvpCampaign" (
  "id", "eventId", "organizationId", "name", "selectionMode",
  "allowGuests", "collectDietary", "isActive", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  'rsvpc_' || md5(e."id"),
  e."id",
  e."organizationId",
  'Dinner',
  'MULTI',
  true,
  true,
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Event" e
WHERE EXISTS (SELECT 1 FROM "RsvpDinner" d WHERE d."eventId" = e."id")
   OR EXISTS (SELECT 1 FROM "RsvpInvite" i WHERE i."eventId" = e."id")
ON CONFLICT ("id") DO NOTHING;

-- 6-7. Point existing rows at their event's campaign. Every RsvpDinner and
--      RsvpInvite has a NOT NULL eventId, and step 5 created a campaign for
--      every event holding either, so this leaves ZERO nulls by construction.
UPDATE "RsvpDinner" d
   SET "campaignId" = c."id"
  FROM "RsvpCampaign" c
 WHERE c."eventId" = d."eventId" AND d."campaignId" IS NULL;

UPDATE "RsvpInvite" i
   SET "campaignId" = c."id"
  FROM "RsvpCampaign" c
 WHERE c."eventId" = i."eventId" AND i."campaignId" IS NULL;

-- 8. FKs for the new columns ------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "RsvpDinner"
    ADD CONSTRAINT "RsvpDinner_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "RsvpCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RsvpInvite"
    ADD CONSTRAINT "RsvpInvite_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "RsvpCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 9. NOT NULL. An item or invite with no campaign is an orphan invisible to
--    every read path, so this is enforced rather than left to application code.
--    Blue/green note: between this migration and the container swap the OLD
--    container's "Add Dinner" would fail its INSERT (it does not write
--    campaignId). With 1 dinner row across 35 events and no live campaign, that
--    window is empty; and the failure mode is a rejected write with a loud
--    error, not corruption.
ALTER TABLE "RsvpDinner" ALTER COLUMN "campaignId" SET NOT NULL;
ALTER TABLE "RsvpInvite" ALTER COLUMN "campaignId" SET NOT NULL;

-- 10-11. Campaign-scoped indexes -------------------------------------------
CREATE INDEX IF NOT EXISTS "RsvpDinner_campaignId_idx" ON "RsvpDinner"("campaignId");
CREATE INDEX IF NOT EXISTS "RsvpInvite_campaignId_idx" ON "RsvpInvite"("campaignId");
CREATE INDEX IF NOT EXISTS "RsvpInvite_campaignId_status_idx" ON "RsvpInvite"("campaignId", "status");

-- The de-dup key moves from the event to the campaign. Created BEFORE the old
-- one is dropped, so there is never a window with no uniqueness at all.
CREATE UNIQUE INDEX IF NOT EXISTS "RsvpInvite_campaignId_inviteeEmail_key"
  ON "RsvpInvite"("campaignId", "inviteeEmail");

-- 12. THE LOAD-BEARING NON-ADDITIVE STATEMENT (see the header).
--     Dropping @@unique([eventId, inviteeEmail]) is what actually permits a
--     person to be on the dinner list AND the workshop list. It only LOOSENS,
--     so an old container's writes still satisfy the stricter rule it believes
--     is in force. The residual risk is that the bulk-add's
--     `createMany({ skipDuplicates: true })` leans on this index to de-dup, so
--     during the swap window a double-submitted bulk add could create a
--     duplicate invite — against 2 invite rows and no live campaign, empty.
--     Precedent: 20260625140000_cert_per_template_uniqueness, "the one
--     non-additive but verified-collision-free migration".
--     At real scale the principled form is expand/contract: ship steps 1-11,
--     deploy, then drop this in the FOLLOWING deploy.
DROP INDEX IF EXISTS "RsvpInvite_eventId_inviteeEmail_key";

-- The plain eventId index is dropped by Prisma's derived schema only if unused;
-- we keep it explicitly (RsvpInvite still carries eventId for the public
-- slug assertion and the tenancy backfill).
CREATE INDEX IF NOT EXISTS "RsvpInvite_eventId_idx" ON "RsvpInvite"("eventId");

-- The old ([eventId, status]) index is superseded by ([campaignId, status]).
DROP INDEX IF EXISTS "RsvpInvite_eventId_status_idx";
