-- Session proposals (July 30, 2026): abstracts-shaped submissions for
-- proposing SESSIONS — organizer inbox only in v1 (no review workflow).
-- Additive + idempotent (blue-green safe): two new tables + one new enum,
-- no changes to existing tables. See docs/SESSION_PROPOSALS_PLAN.md.

DO $$ BEGIN
  CREATE TYPE "SessionProposalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'WITHDRAWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SessionProposalTheme" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionProposalTheme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SessionProposalTheme_eventId_name_key" ON "SessionProposalTheme"("eventId", "name");
CREATE INDEX IF NOT EXISTS "SessionProposalTheme_eventId_idx" ON "SessionProposalTheme"("eventId");

CREATE TABLE IF NOT EXISTS "SessionProposal" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "speakerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "themeId" TEXT,
    "proposedFormat" "SessionType",
    "durationMinutes" INTEGER,
    "status" "SessionProposalStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SessionProposal_eventId_status_idx" ON "SessionProposal"("eventId", "status");
CREATE INDEX IF NOT EXISTS "SessionProposal_organizationId_idx" ON "SessionProposal"("organizationId");
CREATE INDEX IF NOT EXISTS "SessionProposal_speakerId_idx" ON "SessionProposal"("speakerId");

DO $$ BEGIN
  ALTER TABLE "SessionProposalTheme"
    ADD CONSTRAINT "SessionProposalTheme_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SessionProposal"
    ADD CONSTRAINT "SessionProposal_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SessionProposal"
    ADD CONSTRAINT "SessionProposal_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SessionProposal"
    ADD CONSTRAINT "SessionProposal_themeId_fkey"
    FOREIGN KEY ("themeId") REFERENCES "SessionProposalTheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
