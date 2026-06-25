-- Faculty/speaker ticket type flag — additive + idempotent → blue-green safe.
-- Backs the auto-provisioned "Faculty" type for speaker companion registrations
-- (hidden from public registration, excluded from paid-capacity counting).
ALTER TABLE "TicketType"
  ADD COLUMN IF NOT EXISTS "isFaculty" BOOLEAN NOT NULL DEFAULT false;

-- Additive enum value for the speaker companion registration path.
-- IF NOT EXISTS guard → idempotent + blue-green safe (old container ignores it).
ALTER TYPE "RegistrationCreatedSource" ADD VALUE IF NOT EXISTS 'SPEAKER_COMPANION';
