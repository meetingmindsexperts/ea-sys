-- Add speaker agreement HTML to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "speakerAgreementHtml" TEXT;

-- Add speaker agreement acceptance fields to Speaker
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "agreementAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "agreementAcceptedIp" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "agreementAcceptedBy" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "agreementTextSnapshot" TEXT;
