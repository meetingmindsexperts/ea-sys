-- CRM review (July 16, 2026) — H1 + H3 schema halves. Additive + idempotent.
--
-- H1: CrmPipelineStage and CrmEmailTemplate had NO unique constraint, so the
--     first-use seeders could double-seed under a concurrent first load
--     (skipDuplicates only skips rows that violate a UNIQUE constraint — with
--     none, it skips nothing). Adds @@unique([organizationId, name]) to both,
--     after collapsing any duplicates a pre-constraint dev DB may hold.
-- H3: adds CrmPipelineStage.terminalOutcome (WON/LOST) so the deal state machine
--     stops deriving the close outcome from the stage NAME; backfills it from
--     the names the old code recognised.
--
-- NOTE: the CRM migrations have not been applied to prod, so the dedup blocks
-- below only ever fire against dev DBs that raced the old seeders.

-- H3 enum + column
DO $$ BEGIN
  CREATE TYPE "CrmStageOutcome" AS ENUM ('WON', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "CrmPipelineStage" ADD COLUMN IF NOT EXISTS "terminalOutcome" "CrmStageOutcome";

-- H3 backfill — mirror of the name matching the old terminalStatusFor() used,
-- so existing Won/Lost columns keep closing deals after the code stops
-- name-matching. Idempotent (only touches rows still NULL).
UPDATE "CrmPipelineStage"
SET "terminalOutcome" = 'WON'
WHERE "isTerminal" AND "terminalOutcome" IS NULL AND lower(trim("name")) IN ('won', 'closed won');

UPDATE "CrmPipelineStage"
SET "terminalOutcome" = 'LOST'
WHERE "isTerminal" AND "terminalOutcome" IS NULL AND lower(trim("name")) IN ('lost', 'closed lost');

-- H1 dedup (stages): keep the OLDEST row per (org, name); re-point any deals off
-- the newer duplicates first (the FK is Restrict), then delete them.
UPDATE "CrmDeal" d
SET "stageId" = keep.id
FROM "CrmPipelineStage" dup
JOIN LATERAL (
  SELECT k.id
  FROM "CrmPipelineStage" k
  WHERE k."organizationId" = dup."organizationId" AND k."name" = dup."name"
  ORDER BY k."createdAt" ASC, k.id ASC
  LIMIT 1
) keep ON keep.id <> dup.id
WHERE d."stageId" = dup.id;

DELETE FROM "CrmPipelineStage" dup
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "organizationId", "name" ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "CrmPipelineStage"
) ranked
WHERE dup.id = ranked.id AND ranked.rn > 1;

-- H1 dedup (email templates): keep the oldest copy per (org, name). Duplicates
-- here can only be the double-seeded built-ins (the constraint lands before any
-- prod use), so keep-oldest is safe.
DELETE FROM "CrmEmailTemplate" dup
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "organizationId", "name" ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "CrmEmailTemplate"
) ranked
WHERE dup.id = ranked.id AND ranked.rn > 1;

-- H1 unique constraints (names must match Prisma's default mapping)
CREATE UNIQUE INDEX IF NOT EXISTS "CrmPipelineStage_organizationId_name_key"
  ON "CrmPipelineStage"("organizationId", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailTemplate_organizationId_name_key"
  ON "CrmEmailTemplate"("organizationId", "name");
