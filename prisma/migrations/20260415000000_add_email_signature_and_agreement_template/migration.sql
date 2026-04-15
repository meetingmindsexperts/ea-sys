-- Per-user email signature appended to outgoing speaker emails
ALTER TABLE "User" ADD COLUMN "emailSignature" TEXT;

-- Pointer JSON to the uploaded .docx template used to mail-merge
-- personalized speaker agreement attachments.
-- Shape: { url: string, filename: string, uploadedAt: string, uploadedBy: string }
ALTER TABLE "Event" ADD COLUMN "speakerAgreementTemplate" JSONB;
