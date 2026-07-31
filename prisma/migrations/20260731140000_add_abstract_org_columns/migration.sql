-- Multi-tenancy Phase 2 — Abstract domain (Domain #11): Abstract, AbstractTheme,
-- ReviewCriterion (1-hop from Event) + AbstractReviewer, AbstractReviewSubmission
-- (2-hop via Abstract). The reviewer/submitter User is org-independent, but each
-- ROW belongs to the abstract's event's org, so all 5 tables are org-stampable.
-- Additive + idempotent + blue-green safe: nullable denormalized organizationId
-- (no FK), backfilled from the owning Event. The flag-gated RLS policy lives in
-- prisma/rls/abstract.sql (harness + platform bootstrap only, never a migration).

-- ---- columns ----
ALTER TABLE "Abstract"                 ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "AbstractTheme"            ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "ReviewCriterion"          ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "AbstractReviewer"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "AbstractReviewSubmission" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill (1-hop from Event) ----
UPDATE "Abstract" a
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE a."eventId" = e."id" AND a."organizationId" IS NULL;

UPDATE "AbstractTheme" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "ReviewCriterion" c
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE c."eventId" = e."id" AND c."organizationId" IS NULL;

-- ---- backfill (2-hop via the now-stamped Abstract) ----
UPDATE "AbstractReviewer" ar
SET "organizationId" = a."organizationId"
FROM "Abstract" a
WHERE ar."abstractId" = a."id" AND ar."organizationId" IS NULL;

UPDATE "AbstractReviewSubmission" s
SET "organizationId" = a."organizationId"
FROM "Abstract" a
WHERE s."abstractId" = a."id" AND s."organizationId" IS NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "Abstract_organizationId_idx"                 ON "Abstract"("organizationId");
CREATE INDEX IF NOT EXISTS "AbstractTheme_organizationId_idx"            ON "AbstractTheme"("organizationId");
CREATE INDEX IF NOT EXISTS "ReviewCriterion_organizationId_idx"          ON "ReviewCriterion"("organizationId");
CREATE INDEX IF NOT EXISTS "AbstractReviewer_organizationId_idx"         ON "AbstractReviewer"("organizationId");
CREATE INDEX IF NOT EXISTS "AbstractReviewSubmission_organizationId_idx" ON "AbstractReviewSubmission"("organizationId");
