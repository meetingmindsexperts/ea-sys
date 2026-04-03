-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "InvoiceType" AS ENUM ('INVOICE', 'RECEIPT', 'CREDIT_NOTE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Organization billing fields
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyName" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyAddress" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyCity" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyState" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyZipCode" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyCountry" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyPhone" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "companyEmail" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "taxId" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "invoicePrefix" TEXT DEFAULT 'INV';

-- Invoice table
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "paymentId" TEXT,
    "type" "InvoiceType" NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "paidDate" TIMESTAMP(3),
    "subtotal" DECIMAL(10,2) NOT NULL,
    "taxRate" DECIMAL(5,2),
    "taxLabel" TEXT,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "parentInvoiceId" TEXT,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- InvoiceCounter table
CREATE TABLE IF NOT EXISTS "InvoiceCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "InvoiceType" NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_paymentId_key" ON "Invoice"("paymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_organizationId_sequenceNumber_type_key" ON "Invoice"("organizationId", "sequenceNumber", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceCounter_organizationId_type_year_key" ON "InvoiceCounter"("organizationId", "type", "year");

-- Query indexes
CREATE INDEX IF NOT EXISTS "Invoice_eventId_idx" ON "Invoice"("eventId");
CREATE INDEX IF NOT EXISTS "Invoice_registrationId_idx" ON "Invoice"("registrationId");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX IF NOT EXISTS "Invoice_issueDate_idx" ON "Invoice"("issueDate");

-- Foreign keys (idempotent: check before adding)
DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_parentInvoiceId_fkey" FOREIGN KEY ("parentInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
