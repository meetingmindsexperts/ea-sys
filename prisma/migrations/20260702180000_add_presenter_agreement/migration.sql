-- Presenter (abstract-author) agreement acceptance fields on Speaker.
-- Distinct from the faculty speaker agreement columns; a person can be both a
-- faculty speaker and an abstract author and accept the two independently.
-- Additive + idempotent → blue-green safe on live prod.
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "presenterAgreementAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "presenterAgreementAcceptedIp" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "presenterAgreementAcceptedBy" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "presenterAgreementTextSnapshot" TEXT;
