-- Add registrationWelcomeHtml to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationWelcomeHtml" TEXT;
