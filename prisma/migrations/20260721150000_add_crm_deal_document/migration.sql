-- Deal documents — the sponsorship prospectus (one per deal) + supporting
-- files, attachable to the deal's outgoing email. Additive + idempotent:
-- one new enum + table, nothing altered or dropped — blue-green safe.

DO $$ BEGIN
  CREATE TYPE "CrmDealDocumentKind" AS ENUM ('PROSPECTUS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "CrmDealDocument" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "dealId"         TEXT NOT NULL,
  "kind"           "CrmDealDocumentKind" NOT NULL DEFAULT 'OTHER',
  "url"            TEXT NOT NULL,
  "filename"       TEXT NOT NULL,
  "label"          TEXT,
  "mimeType"       TEXT NOT NULL,
  "size"           INTEGER NOT NULL,
  "uploadedById"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmDealDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmDealDocument_dealId_idx" ON "CrmDealDocument"("dealId");
CREATE INDEX IF NOT EXISTS "CrmDealDocument_organizationId_idx" ON "CrmDealDocument"("organizationId");

-- Backstop for the app-level "one prospectus per deal" rule (a new upload
-- replaces the previous row inside a transaction; this catches a race).
-- Partial unique indexes aren't expressible in the Prisma schema, so this
-- lives only in SQL (the SpeakerDocument signed-agreement pattern).
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealDocument_prospectus_one_per_deal"
  ON "CrmDealDocument"("dealId")
  WHERE "kind" = 'PROSPECTUS';

DO $$ BEGIN
  ALTER TABLE "CrmDealDocument" ADD CONSTRAINT "CrmDealDocument_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDealDocument" ADD CONSTRAINT "CrmDealDocument_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDealDocument" ADD CONSTRAINT "CrmDealDocument_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
