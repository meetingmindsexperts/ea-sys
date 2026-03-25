-- Add tax and bank details fields to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(5,2);
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "taxLabel" TEXT DEFAULT 'VAT';
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "bankDetails" TEXT;
