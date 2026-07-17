-- Letterhead images for the generated speaker- and presenter-agreement PDFs
-- (inline HTML→PDF paths). Additive + idempotent — blue-green safe.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "speakerAgreementPdfHeaderImage" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "speakerAgreementPdfFooterImage" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "presenterAgreementPdfHeaderImage" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "presenterAgreementPdfFooterImage" TEXT;
