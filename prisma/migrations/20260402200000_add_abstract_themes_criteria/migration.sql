-- CreateTable AbstractTheme
CREATE TABLE IF NOT EXISTS "AbstractTheme" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbstractTheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable ReviewCriterion
CREATE TABLE IF NOT EXISTS "ReviewCriterion" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCriterion_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on AbstractTheme (eventId, name)
DO $$ BEGIN
    ALTER TABLE "AbstractTheme" ADD CONSTRAINT "AbstractTheme_eventId_name_key" UNIQUE ("eventId", "name");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "AbstractTheme_eventId_idx" ON "AbstractTheme"("eventId");
CREATE INDEX IF NOT EXISTS "ReviewCriterion_eventId_idx" ON "ReviewCriterion"("eventId");

-- Foreign keys
DO $$ BEGIN
    ALTER TABLE "AbstractTheme" ADD CONSTRAINT "AbstractTheme_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ReviewCriterion" ADD CONSTRAINT "ReviewCriterion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add nullable columns to Abstract
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "themeId" TEXT;
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "criteriaScores" JSONB;
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "recommendedFormat" "RecommendedFormat";

-- Foreign key for Abstract.themeId
DO $$ BEGIN
    ALTER TABLE "Abstract" ADD CONSTRAINT "Abstract_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "AbstractTheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
