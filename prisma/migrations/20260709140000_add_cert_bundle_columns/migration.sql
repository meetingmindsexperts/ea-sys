-- Multi-cert-per-email (bundle) model — all additive/idempotent → blue-green
-- safe. Old code never selects the new columns (Prisma uses explicit column
-- lists); new code treats templateIds=[] as "legacy — use certificateTemplateId"
-- and a missing issueRunItemId link as "use the item's issuedCertificateId".
-- No backfill required.

-- (1) A run can now issue SEVERAL templates (1..3). Empty array = legacy
--     single-template run.
ALTER TABLE "CertificateIssueRun" ADD COLUMN IF NOT EXISTS "templateIds" TEXT[] NOT NULL DEFAULT '{}';

-- (2) Flip the item↔cert link to 1:N — one person-keyed run item can carry
--     several certs (one per template). The legacy 1:1 column
--     (CertificateIssueRunItem.issuedCertificateId) stays populated with the
--     FIRST cert so every pre-bundle reader keeps working.
ALTER TABLE "IssuedCertificate" ADD COLUMN IF NOT EXISTS "issueRunItemId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'IssuedCertificate_issueRunItemId_fkey'
  ) THEN
    ALTER TABLE "IssuedCertificate"
      ADD CONSTRAINT "IssuedCertificate_issueRunItemId_fkey"
      FOREIGN KEY ("issueRunItemId") REFERENCES "CertificateIssueRunItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IssuedCertificate_issueRunItemId_idx" ON "IssuedCertificate"("issueRunItemId");
