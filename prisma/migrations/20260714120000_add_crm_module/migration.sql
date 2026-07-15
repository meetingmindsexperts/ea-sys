-- CRM module — see docs/CRM_MODULE_PLAN.md + docs/CRM_STATUS.html
--
-- FULLY ADDITIVE + IDEMPOTENT. Nothing here alters or drops an existing column,
-- and every statement is guarded, so:
--   * the old container can keep serving against this schema during the
--     blue-green swap (it simply never selects these tables), and
--   * a re-run (retry, rollback-then-forward) is a no-op rather than an error.
-- Zero risk to live events: no existing code path references any of this.
--
-- NOTE ON `CrmContact` vs `Contact` (the reason this migration touches NEITHER
-- of Contact's columns): `Contact` is the EVENT contact store — HCPs — and every
-- row in it is mirrored to the external `contacts_centralv1` marketing table by
-- contacts-central-sync, which selects with NO where-clause. A pharma rep in
-- `Contact` would be marketed to as a doctor. Business contacts therefore live in
-- their own table, so that leak is structurally impossible rather than prevented
-- by remembering to filter. `CrmContact.contactId` points at the event Contact for
-- the person who is genuinely both.

DO $$ BEGIN
  CREATE TYPE "CrmDealStatus" AS ENUM ('OPEN', 'WON', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CrmTaskStatus" AS ENUM ('OPEN', 'DONE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CrmLifecycleStage" AS ENUM ('LEAD', 'ENGAGED', 'CUSTOMER', 'CHAMPION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CrmActivityType" AS ENUM ('NOTE', 'CALL', 'MEETING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CrmDealContactRole" AS ENUM ('PRIMARY', 'PROCUREMENT', 'MARKETING', 'TECHNICAL', 'INFLUENCER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CrmCompany" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "country" TEXT,
    "city" TEXT,
    "notes" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCompany_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmPipelineStage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPipelineStage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmDeal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "eventId" TEXT,
    "dealValue" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stageId" TEXT NOT NULL,
    "ownerId" TEXT,
    "expectedClose" TIMESTAMP(3),
    "status" "CrmDealStatus" NOT NULL DEFAULT 'OPEN',
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "sponsorSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "crmContactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "status" "CrmTaskStatus" NOT NULL DEFAULT 'OPEN',
    "remindAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "activityType" "CrmActivityType" NOT NULL DEFAULT 'NOTE',
    "authorId" TEXT,
    "crmContactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "jobTitle" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "notes" TEXT,
    "lifecycleStage" "CrmLifecycleStage",
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmDealContact" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "crmContactId" TEXT NOT NULL,
    "role" "CrmDealContactRole" NOT NULL DEFAULT 'PRIMARY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmDealContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmCompany_organizationId_idx" ON "CrmCompany"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmCompany_organizationId_nameKey_key" ON "CrmCompany"("organizationId", "nameKey");
CREATE INDEX IF NOT EXISTS "CrmPipelineStage_organizationId_sortOrder_idx" ON "CrmPipelineStage"("organizationId", "sortOrder");
CREATE INDEX IF NOT EXISTS "CrmDeal_organizationId_status_idx" ON "CrmDeal"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "CrmDeal_organizationId_stageId_idx" ON "CrmDeal"("organizationId", "stageId");
CREATE INDEX IF NOT EXISTS "CrmDeal_eventId_idx" ON "CrmDeal"("eventId");
CREATE INDEX IF NOT EXISTS "CrmDeal_companyId_idx" ON "CrmDeal"("companyId");
CREATE INDEX IF NOT EXISTS "CrmDeal_ownerId_status_idx" ON "CrmDeal"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "CrmTask_organizationId_status_dueAt_idx" ON "CrmTask"("organizationId", "status", "dueAt");
CREATE INDEX IF NOT EXISTS "CrmTask_ownerId_status_idx" ON "CrmTask"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "CrmTask_dealId_idx" ON "CrmTask"("dealId");
CREATE INDEX IF NOT EXISTS "CrmTask_crmContactId_idx" ON "CrmTask"("crmContactId");
CREATE INDEX IF NOT EXISTS "CrmTask_remindAt_idx" ON "CrmTask"("remindAt");
CREATE INDEX IF NOT EXISTS "CrmNote_organizationId_createdAt_idx" ON "CrmNote"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_crmContactId_createdAt_idx" ON "CrmNote"("crmContactId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_companyId_createdAt_idx" ON "CrmNote"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_dealId_createdAt_idx" ON "CrmNote"("dealId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmContact_organizationId_idx" ON "CrmContact"("organizationId");
CREATE INDEX IF NOT EXISTS "CrmContact_companyId_idx" ON "CrmContact"("companyId");
CREATE INDEX IF NOT EXISTS "CrmContact_contactId_idx" ON "CrmContact"("contactId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_organizationId_emailKey_key" ON "CrmContact"("organizationId", "emailKey");
CREATE INDEX IF NOT EXISTS "CrmDealContact_crmContactId_idx" ON "CrmDealContact"("crmContactId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealContact_dealId_crmContactId_key" ON "CrmDealContact"("dealId", "crmContactId");

-- Partial index serving the reminder worker's exact predicate
--   (remindAt <= now AND remindedAt IS NULL AND status = 'OPEN').
-- Same shape as the cert auto-issue sweep index: without it the 5-minute poll
-- degrades to a full scan as CrmTask grows.
CREATE INDEX IF NOT EXISTS "CrmTask_pending_reminders_idx"
  ON "CrmTask" ("remindAt")
  WHERE "remindedAt" IS NULL AND "status" = 'OPEN';

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- Deletion policy keeps MONEY HISTORY alive: company/stage RESTRICT (can't delete
-- an account or a pipeline column that still holds deals); event/contact/owner
-- SET NULL (the deal outlives them).
DO $$ BEGIN
  ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmPipelineStage" ADD CONSTRAINT "CrmPipelineStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CrmPipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_crmContactId_fkey" FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_crmContactId_fkey" FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_crmContactId_fkey" FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
