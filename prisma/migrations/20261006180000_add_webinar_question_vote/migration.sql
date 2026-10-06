-- Q&A upvotes on the custom-stream attendee page (Oct 6, 2026;
-- docs/WEBINAR_INTERACTION_PLAN.md §3). Additive and idempotent: a new table
-- nothing older reads, so the blue/green window and a rollback are unaffected.

CREATE TABLE IF NOT EXISTS "WebinarQuestionVote" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebinarQuestionVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebinarQuestionVote_questionId_registrationId_key" ON "WebinarQuestionVote"("questionId", "registrationId");
CREATE INDEX IF NOT EXISTS "WebinarQuestionVote_registrationId_idx" ON "WebinarQuestionVote"("registrationId");
CREATE INDEX IF NOT EXISTS "WebinarQuestionVote_eventId_idx" ON "WebinarQuestionVote"("eventId");
CREATE INDEX IF NOT EXISTS "WebinarQuestionVote_organizationId_idx" ON "WebinarQuestionVote"("organizationId");

DO $$ BEGIN
  ALTER TABLE "WebinarQuestionVote" ADD CONSTRAINT "WebinarQuestionVote_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "WebinarViewerQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarQuestionVote" ADD CONSTRAINT "WebinarQuestionVote_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
