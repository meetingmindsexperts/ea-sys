-- Live polls on the webinar's custom-stream page (Oct 6, 2026;
-- docs/WEBINAR_INTERACTION_PLAN.md §5). Additive and idempotent: two new
-- tables nothing older reads, so the blue/green window and a rollback are
-- unaffected.

CREATE TABLE IF NOT EXISTS "LivePoll" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sessionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "showResults" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LivePoll_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LivePoll_sessionId_status_idx" ON "LivePoll"("sessionId", "status");
CREATE INDEX IF NOT EXISTS "LivePoll_eventId_idx" ON "LivePoll"("eventId");
CREATE INDEX IF NOT EXISTS "LivePoll_organizationId_idx" ON "LivePoll"("organizationId");

CREATE TABLE IF NOT EXISTS "LivePollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "choices" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LivePollVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LivePollVote_pollId_registrationId_key" ON "LivePollVote"("pollId", "registrationId");
CREATE INDEX IF NOT EXISTS "LivePollVote_registrationId_idx" ON "LivePollVote"("registrationId");
CREATE INDEX IF NOT EXISTS "LivePollVote_eventId_idx" ON "LivePollVote"("eventId");
CREATE INDEX IF NOT EXISTS "LivePollVote_organizationId_idx" ON "LivePollVote"("organizationId");

DO $$ BEGIN
  ALTER TABLE "LivePoll" ADD CONSTRAINT "LivePoll_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LivePoll" ADD CONSTRAINT "LivePoll_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LivePollVote" ADD CONSTRAINT "LivePollVote_pollId_fkey"
    FOREIGN KEY ("pollId") REFERENCES "LivePoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LivePollVote" ADD CONSTRAINT "LivePollVote_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
