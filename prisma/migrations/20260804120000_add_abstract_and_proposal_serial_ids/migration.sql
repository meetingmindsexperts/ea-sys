-- Abstract serialId — human-readable per-event abstract number ("A-001").
-- Organizer request Aug 4, 2026: an abstract should have an id.
--
-- Additive + idempotent (INC-002 discipline): safe to re-run, safe under
-- blue-green (old code ignores the new column; new code assigns it on create
-- and falls back to "—" display when null).
--
-- 1) Column + counter table.
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "serialId" INTEGER;

CREATE TABLE IF NOT EXISTS "AbstractSerialCounter" (
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AbstractSerialCounter_pkey" PRIMARY KEY ("eventId")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AbstractSerialCounter_eventId_fkey'
    ) THEN
        ALTER TABLE "AbstractSerialCounter"
            ADD CONSTRAINT "AbstractSerialCounter_eventId_fkey"
            FOREIGN KEY ("eventId") REFERENCES "Event"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AbstractSerialCounter_organizationId_idx"
    ON "AbstractSerialCounter"("organizationId");

-- 2) Backfill existing abstracts per event in submission (createdAt) order,
--    continuing from any serials already assigned (idempotent: only NULL rows
--    are numbered, starting above the event's current max).
WITH numbered AS (
    SELECT a.id,
           COALESCE(
               (SELECT MAX(x."serialId") FROM "Abstract" x WHERE x."eventId" = a."eventId"),
               0
           )
           + ROW_NUMBER() OVER (PARTITION BY a."eventId" ORDER BY a."createdAt", a.id) AS serial
    FROM "Abstract" a
    WHERE a."serialId" IS NULL
)
UPDATE "Abstract" a
SET "serialId" = n.serial
FROM numbered n
WHERE a.id = n.id;

-- 3) Seed the counters at each event's current max so the next create
--    continues the sequence (GREATEST keeps a re-run from rewinding).
INSERT INTO "AbstractSerialCounter" ("eventId", "lastSerial", "organizationId")
SELECT a."eventId", MAX(a."serialId"), e."organizationId"
FROM "Abstract" a
JOIN "Event" e ON e.id = a."eventId"
WHERE a."serialId" IS NOT NULL
GROUP BY a."eventId", e."organizationId"
ON CONFLICT ("eventId") DO UPDATE
    SET "lastSerial" = GREATEST("AbstractSerialCounter"."lastSerial", EXCLUDED."lastSerial");

-- 4) Uniqueness — created AFTER the backfill so it can't fail on NULL-heavy
--    partial states (Postgres treats NULLs as distinct anyway).
CREATE UNIQUE INDEX IF NOT EXISTS "Abstract_eventId_serialId_key"
    ON "Abstract"("eventId", "serialId");

-- ────────────────────────────────────────────────────────────────────────────
-- SessionProposal serialId — same feature, "S-001" (organizer request, same
-- day). Identical additive+idempotent shape as the Abstract half above.

ALTER TABLE "SessionProposal" ADD COLUMN IF NOT EXISTS "serialId" INTEGER;

CREATE TABLE IF NOT EXISTS "SessionProposalSerialCounter" (
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SessionProposalSerialCounter_pkey" PRIMARY KEY ("eventId")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SessionProposalSerialCounter_eventId_fkey'
    ) THEN
        ALTER TABLE "SessionProposalSerialCounter"
            ADD CONSTRAINT "SessionProposalSerialCounter_eventId_fkey"
            FOREIGN KEY ("eventId") REFERENCES "Event"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "SessionProposalSerialCounter_organizationId_idx"
    ON "SessionProposalSerialCounter"("organizationId");

-- Backfill existing proposals per event in createdAt order (only NULL rows,
-- continuing above the event's current max — idempotent).
WITH numbered AS (
    SELECT p.id,
           COALESCE(
               (SELECT MAX(x."serialId") FROM "SessionProposal" x WHERE x."eventId" = p."eventId"),
               0
           )
           + ROW_NUMBER() OVER (PARTITION BY p."eventId" ORDER BY p."createdAt", p.id) AS serial
    FROM "SessionProposal" p
    WHERE p."serialId" IS NULL
)
UPDATE "SessionProposal" p
SET "serialId" = n.serial
FROM numbered n
WHERE p.id = n.id;

INSERT INTO "SessionProposalSerialCounter" ("eventId", "lastSerial", "organizationId")
SELECT p."eventId", MAX(p."serialId"), e."organizationId"
FROM "SessionProposal" p
JOIN "Event" e ON e.id = p."eventId"
WHERE p."serialId" IS NOT NULL
GROUP BY p."eventId", e."organizationId"
ON CONFLICT ("eventId") DO UPDATE
    SET "lastSerial" = GREATEST("SessionProposalSerialCounter"."lastSerial", EXCLUDED."lastSerial");

CREATE UNIQUE INDEX IF NOT EXISTS "SessionProposal_eventId_serialId_key"
    ON "SessionProposal"("eventId", "serialId");
