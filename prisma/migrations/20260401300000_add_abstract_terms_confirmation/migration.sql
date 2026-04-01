-- Add abstract terms and confirmation text to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "abstractTermsHtml" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "abstractConfirmationHtml" TEXT;
