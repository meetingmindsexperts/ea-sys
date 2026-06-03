-- Add per-recipient resend tracking on IssuedCertificate.
--
-- Distinct from reprint:
--   reprint = re-render the PDF (existing fields)
--   resend  = re-fire delivery email reusing the existing pdfUrl
--             (these new fields)
--
-- Driven by the per-recipient Resend button on the registration / speaker
-- detail sheets. Each resend bumps both columns atomically inside the
-- /resend route. Pure additive — every existing cert gets resendCount=0,
-- lastResentAt=NULL, which matches the semantic "sent once via original
-- run, never resent."

ALTER TABLE "IssuedCertificate"
  ADD COLUMN "lastResentAt" TIMESTAMP(3),
  ADD COLUMN "resendCount" INTEGER NOT NULL DEFAULT 0;
