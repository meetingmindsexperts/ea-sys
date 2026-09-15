-- CRM quote editor (Sep 15, 2026): a quote becomes a saved, editable record.
--
-- Additive and idempotent: three new tables, their indexes and foreign keys,
-- every statement guarded so a re-run is a no-op. Nothing existing is altered,
-- so the container still running the previous image keeps working against it.
--
-- CrmQuoteSequence replaces CrmQuoteCounter's single org-wide counter with one
-- row per organisation per year (Q-2026-0003). The seed below carries the old
-- counter into this year's row so numbering continues after the quotes already
-- issued rather than starting again at 0001. It runs ON CONFLICT DO NOTHING, so
-- once the new sequence has advanced a re-run can never move it backwards.

CREATE TABLE IF NOT EXISTS "CrmQuoteSequence" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CrmQuoteSequence_pkey" PRIMARY KEY ("organizationId","year")
);

CREATE TABLE IF NOT EXISTS "CrmQuote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "quoteDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "preparedFor" TEXT NOT NULL,
    "attention" TEXT,
    "preparedById" TEXT,
    "preparedByName" TEXT NOT NULL,
    "taxRate" DECIMAL(5,2),
    "taxLabel" TEXT NOT NULL DEFAULT 'VAT',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "terms" TEXT,
    "notes" TEXT,
    "documentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQuote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmQuoteLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "productCode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "crmProductId" TEXT,

    CONSTRAINT "CrmQuoteLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmQuote_documentId_key" ON "CrmQuote"("documentId");
CREATE INDEX IF NOT EXISTS "CrmQuote_dealId_idx" ON "CrmQuote"("dealId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmQuote_organizationId_number_key" ON "CrmQuote"("organizationId", "number");
CREATE INDEX IF NOT EXISTS "CrmQuoteLine_quoteId_sortOrder_idx" ON "CrmQuoteLine"("quoteId", "sortOrder");
CREATE INDEX IF NOT EXISTS "CrmQuoteLine_organizationId_idx" ON "CrmQuoteLine"("organizationId");
CREATE INDEX IF NOT EXISTS "CrmQuoteLine_crmProductId_idx" ON "CrmQuoteLine"("crmProductId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuote_organizationId_fkey') THEN
    ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuote_dealId_fkey') THEN
    ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuote_preparedById_fkey') THEN
    ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuote_documentId_fkey') THEN
    ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CrmDealDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuoteLine_quoteId_fkey') THEN
    ALTER TABLE "CrmQuoteLine" ADD CONSTRAINT "CrmQuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "CrmQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmQuoteLine_crmProductId_fkey') THEN
    ALTER TABLE "CrmQuoteLine" ADD CONSTRAINT "CrmQuoteLine_crmProductId_fkey" FOREIGN KEY ("crmProductId") REFERENCES "CrmProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Continue this year's numbering from the old org-wide counter (Dubai year,
-- the same clock quoteYear() reads in the app).
INSERT INTO "CrmQuoteSequence" ("organizationId", "year", "lastNumber")
SELECT "organizationId", EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Dubai'))::int, "lastNumber"
FROM "CrmQuoteCounter"
WHERE "lastNumber" > 0
ON CONFLICT ("organizationId", "year") DO NOTHING;
