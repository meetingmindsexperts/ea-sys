-- Budget & Procurement module, Phase 1: the budget core (Sep 14, 2026).
-- Spec: docs/BUDGET_PROCUREMENT_MODULE.html §5; plan: docs/BUDGET_PROCUREMENT_BUILD_PLAN.md §5.
--
-- ADDITIVE AND IDEMPOTENT. Nine new tables, eight new enums, four grant
-- columns on "User", one column on "Event", and one unique index on
-- "Event"("organizationId", "code"). Nothing existing is renamed or dropped,
-- so the still-live old container is never surprised, and every statement is
-- IF NOT EXISTS or DO-guarded so a re-run is a no-op. The module ships DARK
-- behind PROCUREMENT_MODULE_ENABLED; these tables exist on every deployment
-- and carry organizationId with an RLS policy in prisma/rls/ from day one
-- (availability and tenancy are different questions, the HR precedent).
--
-- Event.code (owner decision, Sep 14 2026): the unique index only. NO
-- backfill of the 20 events whose code is null. NULLs stay distinct under a
-- unique index, so those events are simply unable to hold a budget until an
-- organiser sets a code. Phase 0 measured production read-only: 19 codes, all
-- distinct, so the index creates cleanly; the DO block below still names any
-- duplicate before the CREATE would fail with an opaque message.
--
-- DECIMAL(18,4) for money (spec §7: store 4 decimals, display 2), DECIMAL(18,8)
-- for FX rates, DECIMAL(18,2) for the AED approval ceiling. People are scalar
-- user ids, never foreign keys: an approval trail outlives the account.
-- Enums
DO $$ BEGIN
  CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'FROZEN', 'CLOSED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "BudgetCategoryType" AS ENUM ('EXPENSE', 'REVENUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EventBrand" AS ENUM ('MMG_EXPERTS', 'MEDCOM', 'MEDULIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "BenchmarkSourceType" AS ENUM ('EA_SYS_BUDGET', 'ARCHIVE_SUMMARY', 'NONE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ApprovalSubjectType" AS ENUM ('BUDGET', 'BUDGET_REALLOCATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "FinancialSummarySource" AS ENUM ('QUICKBOOKS', 'PROCUREMENTEXPRESS', 'EVENTSAIR', 'EA_SYS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Columns on existing tables
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "previousEditionEventId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "procurementApproveCeilingAed" DECIMAL(18,2);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "procurementApproveUnlimited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "procurementRequest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "procurementSettle" BOOLEAN NOT NULL DEFAULT false;

-- Tables
CREATE TABLE IF NOT EXISTS "BudgetCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BudgetCategoryType" NOT NULL DEFAULT 'EXPENSE',
    "parentId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetTemplateLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultQty" DECIMAL(14,4),
    "defaultUnitCost" DECIMAL(18,4),
    "defaultCurrency" TEXT,
    "taxCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetTemplateLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EventBudget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventCode" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "brand" "EventBrand",
    "reportingCurrency" TEXT NOT NULL,
    "contingencyPercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "contingencyAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "plannedExpenseTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxTotalPlanned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "forecastTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "expectedAttendance" INTEGER,
    "recordedAttendance" INTEGER,
    "benchmarkSourceType" "BenchmarkSourceType" NOT NULL DEFAULT 'NONE',
    "benchmarkSourceId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "financeOwnerUserId" TEXT,
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "atRisk" BOOLEAN NOT NULL DEFAULT false,
    "naCategoryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "freezeAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signedOffByUserId" TEXT,
    "closeOutSummary" JSONB,
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "templateLineId" TEXT,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "transactionCurrency" TEXT NOT NULL,
    "fxRateToReporting" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "fxRateSource" TEXT NOT NULL DEFAULT 'manual',
    "fxRateAsOf" TIMESTAMP(3),
    "planned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "committedOpen" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "committedTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "actual" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paid" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxCode" TEXT,
    "taxRatePercent" DECIMAL(5,2),
    "taxAmountPlanned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "forecastFinalAmount" DECIMAL(18,4),
    "forecastReason" TEXT,
    "serviceStart" DATE,
    "serviceEnd" DATE,
    "notes" TEXT,
    "isContingency" BOOLEAN NOT NULL DEFAULT false,
    "varianceNote" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApprovalWorkflowDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subjectType" "ApprovalSubjectType" NOT NULL,
    "bands" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalWorkflowDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectType" "ApprovalSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "amountAed" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4),
    "currency" TEXT,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requesterUserId" TEXT NOT NULL,
    "reason" TEXT,
    "supersededById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApprovalStep" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "assigneeUserId" TEXT NOT NULL,
    "delegateUserId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "remindedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EventFinancialSummary" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceSystem" "FinancialSummarySource" NOT NULL,
    "eventCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "eventType" "EventType",
    "brand" "EventBrand",
    "attendance" INTEGER,
    "currency" TEXT NOT NULL,
    "categoryTotals" JSONB NOT NULL,
    "expenseTotal" DECIMAL(18,4),
    "revenueTotal" DECIMAL(18,4),
    "asOf" TIMESTAMP(3) NOT NULL,
    "eventBudgetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventFinancialSummary_pkey" PRIMARY KEY ("id")
);

-- Event.code uniqueness: name any duplicate before the index would refuse.
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg("organizationId" || ':' || "code" || ' x' || cnt, ', ')
    INTO dup
    FROM (
      SELECT "organizationId", "code", count(*) AS cnt
      FROM "Event"
      WHERE "code" IS NOT NULL
      GROUP BY "organizationId", "code"
      HAVING count(*) > 1
    ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Event.code must be unique per organisation before Phase 1 can apply; duplicates: %', dup;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "BudgetCategory_organizationId_isActive_idx" ON "BudgetCategory"("organizationId", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetCategory_organizationId_code_key" ON "BudgetCategory"("organizationId", "code");
CREATE INDEX IF NOT EXISTS "BudgetTemplate_organizationId_eventType_isActive_idx" ON "BudgetTemplate"("organizationId", "eventType", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetTemplate_organizationId_name_key" ON "BudgetTemplate"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "BudgetTemplateLine_templateId_idx" ON "BudgetTemplateLine"("templateId");
CREATE INDEX IF NOT EXISTS "BudgetTemplateLine_organizationId_idx" ON "BudgetTemplateLine"("organizationId");
CREATE INDEX IF NOT EXISTS "EventBudget_organizationId_status_idx" ON "EventBudget"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "EventBudget_organizationId_eventCode_idx" ON "EventBudget"("organizationId", "eventCode");
CREATE UNIQUE INDEX IF NOT EXISTS "EventBudget_eventId_versionNo_key" ON "EventBudget"("eventId", "versionNo");
CREATE INDEX IF NOT EXISTS "BudgetLine_organizationId_idx" ON "BudgetLine"("organizationId");
CREATE INDEX IF NOT EXISTS "BudgetLine_budgetId_categoryId_idx" ON "BudgetLine"("budgetId", "categoryId");
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetLine_budgetId_lineKey_key" ON "BudgetLine"("budgetId", "lineKey");
CREATE INDEX IF NOT EXISTS "ApprovalWorkflowDefinition_organizationId_subjectType_isAct_idx" ON "ApprovalWorkflowDefinition"("organizationId", "subjectType", "isActive");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_organizationId_status_idx" ON "ApprovalRequest"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_subjectType_subjectId_idx" ON "ApprovalRequest"("subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "ApprovalStep_organizationId_assigneeUserId_status_idx" ON "ApprovalStep"("organizationId", "assigneeUserId", "status");
CREATE INDEX IF NOT EXISTS "ApprovalStep_status_dueAt_idx" ON "ApprovalStep"("status", "dueAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalStep_requestId_sequence_key" ON "ApprovalStep"("requestId", "sequence");
CREATE INDEX IF NOT EXISTS "EventFinancialSummary_organizationId_year_idx" ON "EventFinancialSummary"("organizationId", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "EventFinancialSummary_organizationId_sourceSystem_eventCode_key" ON "EventFinancialSummary"("organizationId", "sourceSystem", "eventCode");
CREATE INDEX IF NOT EXISTS "Event_previousEditionEventId_idx" ON "Event"("previousEditionEventId");
CREATE UNIQUE INDEX IF NOT EXISTS "Event_organizationId_code_key" ON "Event"("organizationId", "code");

-- Foreign keys. Org deletion cascades the module. A budget cascades its lines.
-- A category or template line that a budget line references is RESTRICTED
-- (the line's meaning must not vanish). An event with a budget is RESTRICTED:
-- it has a QuickBooks Class and an approval trail. previousEditionEventId is
-- SET NULL so deleting last year's event never touches this year's.
DO $$ BEGIN
  ALTER TABLE "Event" ADD CONSTRAINT "Event_previousEditionEventId_fkey"
    FOREIGN KEY ("previousEditionEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "BudgetCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetTemplate" ADD CONSTRAINT "BudgetTemplate_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetTemplateLine" ADD CONSTRAINT "BudgetTemplateLine_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetTemplateLine" ADD CONSTRAINT "BudgetTemplateLine_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "BudgetTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetTemplateLine" ADD CONSTRAINT "BudgetTemplateLine_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EventBudget" ADD CONSTRAINT "EventBudget_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EventBudget" ADD CONSTRAINT "EventBudget_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_budgetId_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "EventBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_templateLineId_fkey"
    FOREIGN KEY ("templateLineId") REFERENCES "BudgetTemplateLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ApprovalWorkflowDefinition" ADD CONSTRAINT "ApprovalWorkflowDefinition_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EventFinancialSummary" ADD CONSTRAINT "EventFinancialSummary_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
