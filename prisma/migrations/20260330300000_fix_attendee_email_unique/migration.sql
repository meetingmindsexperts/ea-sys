-- DropIndex: Remove stale unique constraint on Attendee.email
-- The schema defines @@index([email]) (non-unique), but a prior migration
-- created a UNIQUE index. Multiple attendees can share an email (one per event).
DROP INDEX IF EXISTS "Attendee_email_key";

-- Recreate as a regular (non-unique) index to match the schema
CREATE INDEX IF NOT EXISTS "Attendee_email_idx" ON "Attendee"("email");
