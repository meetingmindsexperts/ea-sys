-- Real-time webinar lobby/live presence tracking.
-- Fully additive + idempotent → blue-green safe (the running container
-- ignores the new table/column; first new-code write uses them).

-- Registration.webinarFirstJoinedAt — durable "Joined" indicator (write-once).
ALTER TABLE "Registration"
  ADD COLUMN IF NOT EXISTS "webinarFirstJoinedAt" TIMESTAMP(3);

-- WebinarPresence — one heartbeat-mutated row per (session, registration).
CREATE TABLE IF NOT EXISTS "WebinarPresence" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "sessionId"      TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "firstJoinedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "joinCount"      INTEGER NOT NULL DEFAULT 1,
  "phase"          TEXT NOT NULL DEFAULT 'lobby',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebinarPresence_pkey" PRIMARY KEY ("id")
);

-- Foreign keys (guarded so re-runs don't error).
DO $$ BEGIN
  ALTER TABLE "WebinarPresence" ADD CONSTRAINT "WebinarPresence_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarPresence" ADD CONSTRAINT "WebinarPresence_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "WebinarPresence" ADD CONSTRAINT "WebinarPresence_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "WebinarPresence_sessionId_registrationId_key"
  ON "WebinarPresence" ("sessionId", "registrationId");
CREATE INDEX IF NOT EXISTS "WebinarPresence_sessionId_lastSeenAt_idx"
  ON "WebinarPresence" ("sessionId", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "WebinarPresence_eventId_idx"
  ON "WebinarPresence" ("eventId");
CREATE INDEX IF NOT EXISTS "WebinarPresence_registrationId_idx"
  ON "WebinarPresence" ("registrationId");
