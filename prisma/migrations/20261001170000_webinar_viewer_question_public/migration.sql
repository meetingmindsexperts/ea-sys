-- Q&A tab (Oct 1, 2026): the organizer chooses which viewer questions every
-- attendee may see. Additive and idempotent: one column, default false, so
-- every existing question stays private.
ALTER TABLE "WebinarViewerQuestion" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "WebinarViewerQuestion_sessionId_isPublic_idx" ON "WebinarViewerQuestion"("sessionId", "isPublic");
