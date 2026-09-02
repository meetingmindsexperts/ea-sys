-- Sponsors become a real table (docs/SPONSOR_ATTRIBUTION_PLAN.md phase 2).
--
-- Additive and idempotent throughout: creating a table the old container never
-- queries is invisible to it, the backfill is ON CONFLICT DO NOTHING, and both
-- constraint adds are guarded because Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS. Blue/green safe: nothing existing changes shape.

-- 1. The table. `id` deliberately carries the SAME value the JSON entry had, so
--    every existing Registration.sponsorId resolves without being rewritten.
--    Minting fresh ids would need a second pass over registrations and a window
--    in which the pointer is wrong.
CREATE TABLE IF NOT EXISTS "Sponsor" (
    "id"             TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "organizationId" TEXT,
    "name"           TEXT NOT NULL,
    "tier"           TEXT,
    "logoUrl"        TEXT,
    "websiteUrl"     TEXT,
    "description"    TEXT,
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT, matching what `prisma migrate` generates for @updatedAt.
    -- The backfill below supplies it explicitly; a default here would be a
    -- difference the migration-replay CI job catches.
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Sponsor_eventId_idx" ON "Sponsor"("eventId");
CREATE INDEX IF NOT EXISTS "Sponsor_organizationId_idx" ON "Sponsor"("organizationId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Sponsor_eventId_fkey') THEN
    ALTER TABLE "Sponsor"
      ADD CONSTRAINT "Sponsor_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Backfill from Event.settings.sponsors[]. Rows missing an id or a name are
--    skipped rather than invented: readSponsors() already drops them, so they
--    have never been visible anywhere and materialising them here would be this
--    migration inventing data.
INSERT INTO "Sponsor" ("id", "eventId", "organizationId", "name", "tier", "logoUrl", "websiteUrl", "description", "sortOrder", "updatedAt")
SELECT
    s->>'id',
    e."id",
    e."organizationId",
    s->>'name',
    NULLIF(s->>'tier', ''),
    NULLIF(s->>'logoUrl', ''),
    NULLIF(s->>'websiteUrl', ''),
    NULLIF(s->>'description', ''),
    COALESCE(NULLIF(s->>'sortOrder', '')::int, 0),
    CURRENT_TIMESTAMP
FROM "Event" e
CROSS JOIN LATERAL jsonb_array_elements(e."settings"->'sponsors') AS s
WHERE jsonb_typeof(e."settings"->'sponsors') = 'array'
  AND NULLIF(s->>'id', '')   IS NOT NULL
  AND NULLIF(s->>'name', '') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- 3. The foreign keys, NOT VALID, and that is the load-bearing word.
--
--    Orphans exist BY CONSTRUCTION: the sponsors PUT was replace-all with no
--    in-use check, so removing a sponsor left registrations pointing at an id
--    that is now in no array anywhere. That is the defect this table exists to
--    end, and it means a validating FK would scan the live table and ABORT the
--    migration on exactly the data that motivated it.
--
--    NOT VALID skips the initial scan and still enforces every future write, so
--    no NEW orphan can be created from this moment. Existing ones are reported
--    and cleaned by an operator, and only then is the constraint validated:
--
--      SELECT r.id, r."sponsorId" FROM "Registration" r
--       WHERE r."sponsorId" IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM "Sponsor" s WHERE s.id = r."sponsorId");
--      -- then, once that returns nothing:
--      ALTER TABLE "Registration" VALIDATE CONSTRAINT "Registration_sponsorId_fkey";
--
--    Nulling them here instead would silently destroy attribution somebody
--    entered, which is a decision about who paid for whom and not a migration's
--    to take.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Registration_sponsorId_fkey') THEN
    ALTER TABLE "Registration"
      ADD CONSTRAINT "Registration_sponsorId_fkey"
      FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;

-- PromoCode.sponsorId shipped hours earlier (20260902120000) and is validated on
-- write, so it has no legacy orphans. It still goes in NOT VALID for symmetry
-- and because a row could have been written between the two deploys.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PromoCode_sponsorId_fkey') THEN
    ALTER TABLE "PromoCode"
      ADD CONSTRAINT "PromoCode_sponsorId_fkey"
      FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;
