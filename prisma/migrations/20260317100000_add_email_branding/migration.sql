-- Add email branding fields to Event (idempotent)
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "emailHeaderImage" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "emailFooterHtml" TEXT;
