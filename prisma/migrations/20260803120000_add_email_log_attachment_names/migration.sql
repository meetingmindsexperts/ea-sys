-- Attachment filenames on the email audit row (Aug 3, 2026): what rode on the
-- send — e.g. the paid invoice + receipt PDFs on a payment confirmation.
-- Names only, never the bytes. Additive + idempotent (blue-green safe).
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "attachmentNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
