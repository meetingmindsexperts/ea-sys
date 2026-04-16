-- Sprint B Tranche 1 — abstract review data model refactor
--
-- Drops single-review fields from Abstract and introduces proper per-reviewer
-- assignment + submission tables. No backfill because the system has no prod
-- review data yet (user confirmed 2026-04-17). If running against a dev DB
-- with review data, dump the `reviewScore`/`reviewNotes`/`criteriaScores`/
-- `recommendedFormat` columns from Abstract BEFORE applying.
--
-- Supports:
--   * Multiple reviewers per abstract (1:N via AbstractReviewSubmission)
--   * Explicit reviewer assignment (AbstractReviewer join table)
--   * Event-level `requiredReviewCount` gate on ACCEPTED/REJECTED transitions
--     (stored in Event.settings JSON, enforced at app layer)

-- ── Drop legacy single-review columns from Abstract ──────────────────────────
ALTER TABLE "Abstract" DROP COLUMN IF EXISTS "reviewNotes";
ALTER TABLE "Abstract" DROP COLUMN IF EXISTS "reviewScore";
ALTER TABLE "Abstract" DROP COLUMN IF EXISTS "criteriaScores";
ALTER TABLE "Abstract" DROP COLUMN IF EXISTS "recommendedFormat";

-- ── New enum: AbstractReviewerRole ───────────────────────────────────────────
CREATE TYPE "AbstractReviewerRole" AS ENUM ('PRIMARY', 'SECONDARY', 'CONSULTING');

-- ── New table: AbstractReviewer (assignment metadata) ────────────────────────
CREATE TABLE "AbstractReviewer" (
    "id"           TEXT                   NOT NULL,
    "abstractId"   TEXT                   NOT NULL,
    "userId"       TEXT                   NOT NULL,
    "assignedAt"   TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT                   NOT NULL,
    "role"         "AbstractReviewerRole" NOT NULL DEFAULT 'SECONDARY',
    "conflictFlag" BOOLEAN                NOT NULL DEFAULT false,
    CONSTRAINT "AbstractReviewer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AbstractReviewer_abstractId_userId_key" ON "AbstractReviewer"("abstractId", "userId");
CREATE INDEX "AbstractReviewer_abstractId_idx" ON "AbstractReviewer"("abstractId");
CREATE INDEX "AbstractReviewer_userId_idx" ON "AbstractReviewer"("userId");

ALTER TABLE "AbstractReviewer"
    ADD CONSTRAINT "AbstractReviewer_abstractId_fkey"
    FOREIGN KEY ("abstractId") REFERENCES "Abstract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AbstractReviewer"
    ADD CONSTRAINT "AbstractReviewer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AbstractReviewer"
    ADD CONSTRAINT "AbstractReviewer_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── New table: AbstractReviewSubmission (one per reviewer per abstract) ──────
-- Upsert target: (abstractId, reviewerUserId). A reviewer editing their own
-- submission updates the existing row rather than creating duplicates.
CREATE TABLE "AbstractReviewSubmission" (
    "id"                 TEXT                NOT NULL,
    "abstractId"         TEXT                NOT NULL,
    "reviewerUserId"     TEXT                NOT NULL,
    "abstractReviewerId" TEXT,
    "criteriaScores"     JSONB,
    "overallScore"       INTEGER,
    "reviewNotes"        TEXT,
    "recommendedFormat"  "RecommendedFormat",
    "confidence"         INTEGER,
    "submittedAt"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3)        NOT NULL,
    CONSTRAINT "AbstractReviewSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AbstractReviewSubmission_abstractId_reviewerUserId_key" ON "AbstractReviewSubmission"("abstractId", "reviewerUserId");
CREATE INDEX "AbstractReviewSubmission_abstractId_idx" ON "AbstractReviewSubmission"("abstractId");
CREATE INDEX "AbstractReviewSubmission_reviewerUserId_idx" ON "AbstractReviewSubmission"("reviewerUserId");

ALTER TABLE "AbstractReviewSubmission"
    ADD CONSTRAINT "AbstractReviewSubmission_abstractId_fkey"
    FOREIGN KEY ("abstractId") REFERENCES "Abstract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AbstractReviewSubmission"
    ADD CONSTRAINT "AbstractReviewSubmission_reviewerUserId_fkey"
    FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unassigning a reviewer preserves their submission by nulling this FK
-- (matches the intent in the Sprint B plan — submissions have independent
-- value, assignment is workflow metadata).
ALTER TABLE "AbstractReviewSubmission"
    ADD CONSTRAINT "AbstractReviewSubmission_abstractReviewerId_fkey"
    FOREIGN KEY ("abstractReviewerId") REFERENCES "AbstractReviewer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
