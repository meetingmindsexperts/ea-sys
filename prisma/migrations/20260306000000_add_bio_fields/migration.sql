-- Add bio field to Attendee and Contact (idempotent)
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "bio" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "bio" TEXT;
