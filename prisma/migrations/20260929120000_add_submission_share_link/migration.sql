-- Shared submission views (Sep 29, 2026): a public, read-only page of an
-- event's abstracts or session proposals behind a secret link. Additive and
-- idempotent: one new enum and one new table, nothing existing touched.
DO $$ BEGIN
  CREATE TYPE "SubmissionShareKind" AS ENUM ('ABSTRACTS', 'SESSION_PROPOSALS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SubmissionShareLink" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "kind" "SubmissionShareKind" NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "statuses" TEXT[],
    "fields" TEXT[],
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubmissionShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubmissionShareLink_token_key" ON "SubmissionShareLink"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "SubmissionShareLink_eventId_kind_key" ON "SubmissionShareLink"("eventId", "kind");
CREATE INDEX IF NOT EXISTS "SubmissionShareLink_organizationId_idx" ON "SubmissionShareLink"("organizationId");

DO $$ BEGIN
  ALTER TABLE "SubmissionShareLink" ADD CONSTRAINT "SubmissionShareLink_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
