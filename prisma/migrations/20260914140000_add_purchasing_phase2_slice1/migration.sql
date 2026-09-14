-- Budget & Procurement, Phase 2 (purchasing), slice 1: the tables (Sep 14, 2026).
-- Spec docs/BUDGET_PROCUREMENT_MODULE.html §5; plan docs/BUDGET_PROCUREMENT_BUILD_PLAN.md §6.
--
-- ADDITIVE AND IDEMPOTENT. Ten new enums, nine new tables (seven purchasing
-- tables and the two year-keyed document counters), one nullable column on
-- "BudgetLine". Nothing existing is renamed or dropped, so the still-live old
-- container is never surprised, and every statement is IF NOT EXISTS or
-- DO-guarded so a re-run is a no-op. The module ships DARK behind
-- PROCUREMENT_MODULE_ENABLED; every table carries organizationId with an RLS
-- policy in prisma/rls/procurement.sql from day one.
--
-- Document numbers (owner decision, 14 Sep 2026): PR-2026-0001 / PO-2026-0001,
-- the year in the number and the sequence restarting each January, so the
-- counters key on (organizationId, year). DECIMAL(18,4) for money ex-VAT with
-- the tax beside it, DECIMAL(18,8) for rates. People are scalar user ids.

-- Enums
DO $$ BEGIN
  CREATE TYPE "SupplierApprovalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SupplierRiskStatus" AS ENUM ('NONE', 'WATCH', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SpendRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'BUDGET_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'AWAITING_SUPPLIER', 'CONVERTED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "BudgetCheckStatus" AS ENUM ('NOT_CHECKED', 'WITHIN_BUDGET', 'OVER_BUDGET', 'FROZEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SourcingMethod" AS ENUM ('SINGLE_QUOTE', 'COMPETITIVE_QUOTES', 'EXISTING_CONTRACT', 'SOLE_SOURCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SpendRequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CommitmentStatus" AS ENUM ('APPROVED', 'SENT_TO_ACCOUNTING', 'POSTED', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "FulfillmentStatus" AS ENUM ('OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AccountingSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'LINKED_EXTERNAL', 'DIVERGED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PaymentRecordStatus" AS ENUM ('RECORDED', 'CLEARED', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables
CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "taxRegistrationNo" TEXT,
    "country" TEXT,
    "currency" TEXT NOT NULL,
    "contacts" JSONB NOT NULL DEFAULT '[]',
    "paymentTerms" TEXT,
    "bankDetails" JSONB,
    "externalSystemType" TEXT,
    "externalVendorId" TEXT,
    "approvalStatus" "SupplierApprovalStatus" NOT NULL DEFAULT 'PROPOSED',
    "riskStatus" "SupplierRiskStatus" NOT NULL DEFAULT 'NONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "proposedByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SupplierProduct" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unitCost" DECIMAL(18,4),
    "currency" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SpendRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestNo" TEXT NOT NULL,
    "budgetId" TEXT,
    "lineKey" TEXT,
    "eventCode" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "departmentId" TEXT,
    "supplierId" TEXT,
    "proposedVendorName" TEXT,
    "title" TEXT NOT NULL,
    "justification" TEXT,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "fxRateToReporting" DECIMAL(18,8),
    "amountAed" DECIMAL(18,4),
    "categoryId" TEXT,
    "neededBy" DATE,
    "sourcingMethod" "SourcingMethod",
    "budgetCheckStatus" "BudgetCheckStatus" NOT NULL DEFAULT 'NOT_CHECKED',
    "status" "SpendRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "SpendRequestPriority" NOT NULL DEFAULT 'NORMAL',
    "linkedCommitmentId" TEXT,
    "approvalRequestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SpendRequestQuote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "spendRequestId" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "supplierId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "quotedOn" DATE,
    "validUntil" DATE,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "mediaFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendRequestQuote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Commitment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "commitmentNo" TEXT NOT NULL,
    "spendRequestId" TEXT,
    "budgetId" TEXT,
    "lineKey" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "eventCode" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "fxRateToReporting" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "status" "CommitmentStatus" NOT NULL DEFAULT 'APPROVED',
    "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'OPEN',
    "accountingSyncStatus" "AccountingSyncStatus" NOT NULL DEFAULT 'PENDING',
    "externalDocumentType" TEXT,
    "externalDocumentId" TEXT,
    "externalDocNumber" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "sentToSupplierAt" TIMESTAMP(3),
    "pdfUrl" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "receiptConfirmedAt" TIMESTAMP(3),
    "receiptConfirmedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CommitmentLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "categoryId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxCode" TEXT,
    "taxRatePercent" DECIMAL(5,2),
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitmentLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "commitmentId" TEXT,
    "supplierInvoiceId" TEXT,
    "reference" TEXT,
    "paidOn" DATE NOT NULL,
    "grossAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "fxRate" DECIMAL(18,8),
    "method" TEXT,
    "status" "PaymentRecordStatus" NOT NULL DEFAULT 'RECORDED',
    "externalPaymentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SpendRequestCounter" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SpendRequestCounter_pkey" PRIMARY KEY ("organizationId", "year")
);

CREATE TABLE IF NOT EXISTS "CommitmentCounter" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommitmentCounter_pkey" PRIMARY KEY ("organizationId", "year")
);

-- Column on an existing table
ALTER TABLE "BudgetLine" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_organizationId_code_key" ON "Supplier"("organizationId", "code");
CREATE INDEX IF NOT EXISTS "Supplier_organizationId_approvalStatus_idx" ON "Supplier"("organizationId", "approvalStatus");
CREATE INDEX IF NOT EXISTS "Supplier_organizationId_isActive_idx" ON "Supplier"("organizationId", "isActive");
CREATE INDEX IF NOT EXISTS "SupplierProduct_organizationId_idx" ON "SupplierProduct"("organizationId");
CREATE INDEX IF NOT EXISTS "SupplierProduct_supplierId_idx" ON "SupplierProduct"("supplierId");
CREATE UNIQUE INDEX IF NOT EXISTS "SpendRequest_organizationId_requestNo_key" ON "SpendRequest"("organizationId", "requestNo");
CREATE INDEX IF NOT EXISTS "SpendRequest_organizationId_status_idx" ON "SpendRequest"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "SpendRequest_budgetId_idx" ON "SpendRequest"("budgetId");
CREATE INDEX IF NOT EXISTS "SpendRequest_requesterUserId_idx" ON "SpendRequest"("requesterUserId");
CREATE INDEX IF NOT EXISTS "SpendRequestQuote_organizationId_idx" ON "SpendRequestQuote"("organizationId");
CREATE INDEX IF NOT EXISTS "SpendRequestQuote_spendRequestId_idx" ON "SpendRequestQuote"("spendRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "Commitment_organizationId_commitmentNo_key" ON "Commitment"("organizationId", "commitmentNo");
CREATE INDEX IF NOT EXISTS "Commitment_organizationId_status_idx" ON "Commitment"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "Commitment_budgetId_lineKey_idx" ON "Commitment"("budgetId", "lineKey");
CREATE INDEX IF NOT EXISTS "Commitment_supplierId_idx" ON "Commitment"("supplierId");
CREATE INDEX IF NOT EXISTS "CommitmentLine_organizationId_idx" ON "CommitmentLine"("organizationId");
CREATE INDEX IF NOT EXISTS "CommitmentLine_commitmentId_idx" ON "CommitmentLine"("commitmentId");
CREATE INDEX IF NOT EXISTS "PaymentRecord_organizationId_idx" ON "PaymentRecord"("organizationId");
CREATE INDEX IF NOT EXISTS "PaymentRecord_commitmentId_idx" ON "PaymentRecord"("commitmentId");
CREATE INDEX IF NOT EXISTS "BudgetLine_supplierId_idx" ON "BudgetLine"("supplierId");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequest" ADD CONSTRAINT "SpendRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequest" ADD CONSTRAINT "SpendRequest_budgetId_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "EventBudget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequest" ADD CONSTRAINT "SpendRequest_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequest" ADD CONSTRAINT "SpendRequest_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequestQuote" ADD CONSTRAINT "SpendRequestQuote_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequestQuote" ADD CONSTRAINT "SpendRequestQuote_spendRequestId_fkey"
    FOREIGN KEY ("spendRequestId") REFERENCES "SpendRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequestQuote" ADD CONSTRAINT "SpendRequestQuote_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpendRequestQuote" ADD CONSTRAINT "SpendRequestQuote_mediaFileId_fkey"
    FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_spendRequestId_fkey"
    FOREIGN KEY ("spendRequestId") REFERENCES "SpendRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_budgetId_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "EventBudget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommitmentLine" ADD CONSTRAINT "CommitmentLine_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommitmentLine" ADD CONSTRAINT "CommitmentLine_commitmentId_fkey"
    FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommitmentLine" ADD CONSTRAINT "CommitmentLine_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_commitmentId_fkey"
    FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
