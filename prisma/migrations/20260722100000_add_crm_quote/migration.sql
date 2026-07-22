-- CRM quotes — generated quote PDFs stored as deal documents (kind QUOTE),
-- numbered org-sequentially via a counter table. Additive + idempotent:
-- one enum value + one tiny table, nothing altered or dropped — blue-green safe.

ALTER TYPE "CrmDealDocumentKind" ADD VALUE IF NOT EXISTS 'QUOTE';

CREATE TABLE IF NOT EXISTS "CrmQuoteCounter" (
  "organizationId" TEXT NOT NULL,
  "lastNumber"     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CrmQuoteCounter_pkey" PRIMARY KEY ("organizationId")
);
