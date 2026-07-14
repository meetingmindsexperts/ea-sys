-- CRM module — see docs/CRM_MODULE_PLAN.md
--
-- FULLY ADDITIVE + IDEMPOTENT. Nothing here alters or drops an existing column,
-- and every statement is guarded, so:
--   * the old container can keep serving against this schema during the
--     blue-green swap (it simply never selects these tables), and
--   * a re-run (retry, rollback-then-forward) is a no-op rather than an error.
-- Zero risk to live events: no existing code path references any of this yet.

-- ── Enums ────────────────────────────────────────────────────────────────────
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

-- ── CrmCompany ───────────────────────────────────────────────────────────────
-- nameKey = trimmed + lowercased name; it carries the unique index while `name`
-- stays the display form. Normalizing IN THE INDEX (rather than trusting every
-- writer to lowercase) makes the contacts-review H2 duplicate-row bug
-- unrepresentable here.
CREATE TABLE IF NOT EXISTS "CrmCompany" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "nameKey"        TEXT NOT NULL,
  "industry"       TEXT,
  "website"        TEXT,
  "country"        TEXT,
  "city"           TEXT,
  "notes"          TEXT,
  "needsReview"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmCompany_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmCompany_organizationId_nameKey_key"
  ON "CrmCompany" ("organizationId", "nameKey");
CREATE INDEX IF NOT EXISTS "CrmCompany_organizationId_idx"
  ON "CrmCompany" ("organizationId");

-- ── CrmPipelineStage ─────────────────────────────────────────────────────────
-- A TABLE, not an enum: sales will change the pipeline, and that must be a row
-- edit rather than a migration against a live DB.
CREATE TABLE IF NOT EXISTS "CrmPipelineStage" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "sortOrder"      INTEGER NOT NULL,
  "isTerminal"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmPipelineStage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmPipelineStage_organizationId_sortOrder_idx"
  ON "CrmPipelineStage" ("organizationId", "sortOrder");

-- ── CrmDeal ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CrmDeal" (
  "id"              TEXT NOT NULL,
  "organizationId"  TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "companyId"       TEXT,
  "contactId"       TEXT,
  "eventId"         TEXT,
  "dealValue"       DECIMAL(12,2),
  "currency"        TEXT NOT NULL DEFAULT 'USD',
  "stageId"         TEXT NOT NULL,
  "ownerId"         TEXT,
  "expectedClose"   TIMESTAMP(3),
  "status"          "CrmDealStatus" NOT NULL DEFAULT 'OPEN',
  "wonAt"           TIMESTAMP(3),
  "lostAt"          TIMESTAMP(3),
  "lostReason"      TEXT,
  "sponsorSyncedAt" TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmDeal_organizationId_status_idx"  ON "CrmDeal" ("organizationId", "status");
CREATE INDEX IF NOT EXISTS "CrmDeal_organizationId_stageId_idx" ON "CrmDeal" ("organizationId", "stageId");
CREATE INDEX IF NOT EXISTS "CrmDeal_eventId_idx"                ON "CrmDeal" ("eventId");
CREATE INDEX IF NOT EXISTS "CrmDeal_companyId_idx"              ON "CrmDeal" ("companyId");
CREATE INDEX IF NOT EXISTS "CrmDeal_ownerId_status_idx"         ON "CrmDeal" ("ownerId", "status");

-- ── CrmTask ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CrmTask" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  "dueAt"          TIMESTAMP(3),
  "ownerId"        TEXT,
  "contactId"      TEXT,
  "companyId"      TEXT,
  "dealId"         TEXT,
  "status"         "CrmTaskStatus" NOT NULL DEFAULT 'OPEN',
  "remindAt"       TIMESTAMP(3),
  "remindedAt"     TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmTask_organizationId_status_dueAt_idx"
  ON "CrmTask" ("organizationId", "status", "dueAt");
CREATE INDEX IF NOT EXISTS "CrmTask_ownerId_status_idx" ON "CrmTask" ("ownerId", "status");
CREATE INDEX IF NOT EXISTS "CrmTask_dealId_idx"         ON "CrmTask" ("dealId");
CREATE INDEX IF NOT EXISTS "CrmTask_remindAt_idx"       ON "CrmTask" ("remindAt");

-- Partial index serving the reminder worker's exact predicate
--   (remindAt <= now AND remindedAt IS NULL AND status = 'OPEN').
-- Same shape as the cert auto-issue sweep index: the job scans due-and-unsent
-- rows every 5 min, and without this it degrades to a full scan as CrmTask grows.
CREATE INDEX IF NOT EXISTS "CrmTask_pending_reminders_idx"
  ON "CrmTask" ("remindAt")
  WHERE "remindedAt" IS NULL AND "status" = 'OPEN';

-- ── CrmNote ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CrmNote" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "activityType"   "CrmActivityType" NOT NULL DEFAULT 'NOTE',
  "authorId"       TEXT,
  "contactId"      TEXT,
  "companyId"      TEXT,
  "dealId"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmNote_organizationId_createdAt_idx" ON "CrmNote" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_contactId_createdAt_idx"      ON "CrmNote" ("contactId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_companyId_createdAt_idx"      ON "CrmNote" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmNote_dealId_createdAt_idx"         ON "CrmNote" ("dealId", "createdAt");

-- ── Contact: two additive nullable columns ───────────────────────────────────
-- The existing free-text Contact.organization string is deliberately KEPT — it
-- stays the raw captured value while companyId becomes the curated link. Both
-- columns are nullable with no default, so every existing row is untouched and
-- no backfill is required for this migration to be correct.
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "companyId"      TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lifecycleStage" "CrmLifecycleStage";

CREATE INDEX IF NOT EXISTS "Contact_companyId_idx" ON "Contact" ("companyId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- Deletion policy is chosen so MONEY HISTORY SURVIVES:
--   company/stage → RESTRICT  (can't delete an account or a pipeline column that
--                              still holds deals — move or close them first)
--   event/contact/owner → SET NULL (the deal outlives them; an unowned or
--                              event-less deal is recoverable, a vaporised one isn't)
-- Every FK is added under a guard so a re-run is a no-op.
DO $$ BEGIN
  ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmPipelineStage" ADD CONSTRAINT "CrmPipelineStage_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "CrmPipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmTask" ADD CONSTRAINT "CrmTask_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
