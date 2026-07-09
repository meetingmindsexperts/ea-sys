-- Bulk "resend latest to everyone" — reissue runs re-render + re-send
-- already-issued certs from the current template. Additive, blue-green safe
-- (old code ignores the column; new code reads it).
ALTER TABLE "CertificateIssueRun" ADD COLUMN IF NOT EXISTS "reissue" BOOLEAN NOT NULL DEFAULT false;

-- Dedicated reissue counters on IssuedCertificate (re-render + resend from the
-- current template). Additive, blue-green safe.
ALTER TABLE "IssuedCertificate" ADD COLUMN IF NOT EXISTS "lastReissuedAt" TIMESTAMP(3);
ALTER TABLE "IssuedCertificate" ADD COLUMN IF NOT EXISTS "reissueCount" INTEGER NOT NULL DEFAULT 0;
