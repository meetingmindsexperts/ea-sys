-- Add abstractWelcomeHtml to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "abstractWelcomeHtml" TEXT;
