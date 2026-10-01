-- Webinar questions from custom-stream viewers (Oct 1, 2026). Separate from
-- "WebinarQuestion", which holds Zoom's post-webinar Q&A report. Additive and
-- idempotent: one new table, nothing existing touched.
CREATE TABLE IF NOT EXISTS "WebinarViewerQuestion" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sessionId" TEXT NOT NULL,
    "registrationId" TEXT,
    "askerName" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebinarViewerQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebinarViewerQuestion_sessionId_createdAt_idx" ON "WebinarViewerQuestion"("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS "WebinarViewerQuestion_eventId_idx" ON "WebinarViewerQuestion"("eventId");
CREATE INDEX IF NOT EXISTS "WebinarViewerQuestion_organizationId_idx" ON "WebinarViewerQuestion"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarViewerQuestion_registrationId_idx" ON "WebinarViewerQuestion"("registrationId");

DO $$ BEGIN
  ALTER TABLE "WebinarViewerQuestion" ADD CONSTRAINT "WebinarViewerQuestion_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarViewerQuestion" ADD CONSTRAINT "WebinarViewerQuestion_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarViewerQuestion" ADD CONSTRAINT "WebinarViewerQuestion_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
