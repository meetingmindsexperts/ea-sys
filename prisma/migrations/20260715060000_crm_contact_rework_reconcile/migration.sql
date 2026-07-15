-- CRM contact rework — RECONCILE migration.
--
-- WHY THIS EXISTS (incident 2026-07-15). The migration 20260714120000_add_crm_module
-- was edited IN PLACE after its FIRST version had already deployed to production:
-- v1 (commit 7b4ff6b) created CrmDeal/Task/Note.contactId + Contact.companyId/
-- lifecycleStage; v2 (commit 54fba94) rewrote it to use CrmContact + CrmDealContact
-- and crmContactId. Prisma records a migration as applied BY NAME, so `migrate
-- deploy` skipped the edited file — prod kept the v1 shape while the new client
-- expected v2, and every CRM read 500'd ("table public.CrmContact does not exist").
--
-- This migration reconciles a v1-shaped database to v2. It is FULLY GUARDED so it is
-- a NO-OP on a fresh database (where 20260714120000 already ran as v2): CREATE IF
-- NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS all skip cleanly.
--
-- Scope is CRM-ONLY. The prod diff also surfaced unrelated drift on
-- CertificateIssueRun / IssuedCertificate / AlertState — that is a SEPARATE issue
-- and is deliberately NOT touched here (one incident fix, one concern).
--
-- SAFE ON DATA: the CRM has zero rows in prod, so dropping the v1 columns/tables
-- loses nothing. Contact is populated but companyId/lifecycleStage were never
-- written (no UI ever shipped for them), so those drops are all-NULL metadata ops.

-- ── enum added in v2 ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CrmDealContactRole" AS ENUM ('PRIMARY', 'PROCUREMENT', 'MARKETING', 'TECHNICAL', 'INFLUENCER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── new tables (create BEFORE the crmContactId FKs that reference CrmContact) ──
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
CREATE INDEX IF NOT EXISTS "CrmContact_organizationId_idx" ON "CrmContact"("organizationId");
CREATE INDEX IF NOT EXISTS "CrmContact_companyId_idx" ON "CrmContact"("companyId");
CREATE INDEX IF NOT EXISTS "CrmContact_contactId_idx" ON "CrmContact"("contactId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_organizationId_emailKey_key" ON "CrmContact"("organizationId", "emailKey");

CREATE TABLE IF NOT EXISTS "CrmDealContact" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "crmContactId" TEXT NOT NULL,
    "role" "CrmDealContactRole" NOT NULL DEFAULT 'PRIMARY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmDealContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmDealContact_crmContactId_idx" ON "CrmDealContact"("crmContactId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDealContact_dealId_crmContactId_key" ON "CrmDealContact"("dealId", "crmContactId");

-- ── CrmContact FKs ───────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CrmDealContact FKs ───────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_crmContactId_fkey"
    FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CrmTask: contactId → crmContactId ────────────────────────────────────────
ALTER TABLE "CrmTask" ADD COLUMN IF NOT EXISTS "crmContactId" TEXT;
CREATE INDEX IF NOT EXISTS "CrmTask_crmContactId_idx" ON "CrmTask"("crmContactId");
DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_crmContactId_fkey"
    FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DROP COLUMN IF EXISTS auto-drops the old CrmTask_contactId_fkey.
ALTER TABLE "CrmTask" DROP COLUMN IF EXISTS "contactId";

-- ── CrmNote: contactId → crmContactId ────────────────────────────────────────
ALTER TABLE "CrmNote" ADD COLUMN IF NOT EXISTS "crmContactId" TEXT;
CREATE INDEX IF NOT EXISTS "CrmNote_crmContactId_createdAt_idx" ON "CrmNote"("crmContactId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_crmContactId_fkey"
    FOREIGN KEY ("crmContactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP INDEX IF EXISTS "CrmNote_contactId_createdAt_idx";
ALTER TABLE "CrmNote" DROP COLUMN IF EXISTS "contactId";

-- ── CrmDeal: drop the v1 singular contactId (replaced by the CrmDealContact join)
ALTER TABLE "CrmDeal" DROP COLUMN IF EXISTS "contactId";

-- ── Contact: drop the v1 CRM columns (business contacts are now their own table)
DROP INDEX IF EXISTS "Contact_companyId_idx";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "lifecycleStage";
