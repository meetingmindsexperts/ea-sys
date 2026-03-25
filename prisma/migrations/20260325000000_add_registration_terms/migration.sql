-- Add registrationTermsHtml to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationTermsHtml" TEXT;
