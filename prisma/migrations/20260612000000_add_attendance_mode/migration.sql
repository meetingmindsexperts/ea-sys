-- Hybrid attendance: per-registration mode + per-ticket virtual price.
-- Fully additive + idempotent → blue-green safe (the running container
-- ignores the new column/type/value; first new-code write uses them).

-- AttendanceMode enum (guard so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttendanceMode') THEN
    CREATE TYPE "AttendanceMode" AS ENUM ('IN_PERSON', 'VIRTUAL');
  END IF;
END$$;

-- Registration.attendanceMode — every existing row defaults to IN_PERSON.
ALTER TABLE "Registration"
  ADD COLUMN IF NOT EXISTS "attendanceMode" "AttendanceMode" NOT NULL DEFAULT 'IN_PERSON';

CREATE INDEX IF NOT EXISTS "Registration_eventId_attendanceMode_idx"
  ON "Registration" ("eventId", "attendanceMode");

-- TicketType.virtualPrice — nullable; null ⇒ virtual falls back to in-person price.
ALTER TABLE "TicketType"
  ADD COLUMN IF NOT EXISTS "virtualPrice" DECIMAL(10,2);
