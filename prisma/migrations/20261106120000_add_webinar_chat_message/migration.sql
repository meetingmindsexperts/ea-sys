-- Attendee chat on a webinar's Custom stream page (Nov 6, 2026;
-- docs/WEBINAR_INTERACTION_PLAN.md §6). Additive and idempotent: one new table,
-- nothing existing touched.
CREATE TABLE IF NOT EXISTS "WebinarChatMessage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sessionId" TEXT NOT NULL,
    "registrationId" TEXT,
    "userId" TEXT,
    "authorName" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "handoutId" TEXT,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebinarChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebinarChatMessage_sessionId_createdAt_idx" ON "WebinarChatMessage"("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS "WebinarChatMessage_eventId_idx" ON "WebinarChatMessage"("eventId");
CREATE INDEX IF NOT EXISTS "WebinarChatMessage_organizationId_idx" ON "WebinarChatMessage"("organizationId");
CREATE INDEX IF NOT EXISTS "WebinarChatMessage_registrationId_idx" ON "WebinarChatMessage"("registrationId");

DO $$ BEGIN
  ALTER TABLE "WebinarChatMessage" ADD CONSTRAINT "WebinarChatMessage_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarChatMessage" ADD CONSTRAINT "WebinarChatMessage_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarChatMessage" ADD CONSTRAINT "WebinarChatMessage_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
