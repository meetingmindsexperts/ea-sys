-- AlterEnum: add INCLUSIVE payment status for sponsor-paid registrations
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'INCLUSIVE';

-- AlterTable: sponsor attribution (refs Event.settings.sponsors[].id in JSON;
-- no FK because sponsors are stored as a JSON array, not a Prisma table)
ALTER TABLE "Registration"
  ADD COLUMN IF NOT EXISTS "sponsorId" TEXT;

CREATE INDEX IF NOT EXISTS "Registration_sponsorId_idx" ON "Registration"("sponsorId");
