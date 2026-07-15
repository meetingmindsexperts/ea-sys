-- CRM detailed activity log + soft-delete (archive) support.
--
-- Additive + idempotent. Safe on live prod (INC-003 discipline): one new enum,
-- one new table, four new NULLABLE columns. No column is dropped or made NOT NULL;
-- every existing CRM row stays active (archivedAt NULL) and readable.

-- 1. Which entity an activity row is about.
DO $$ BEGIN
  CREATE TYPE "CrmActivityEntity" AS ENUM ('DEAL', 'COMPANY', 'CONTACT', 'TASK');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Soft-delete stamp on the four record types. NULL = active.
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "CrmDeal"    ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "CrmTask"    ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- 3. The activity log table.
CREATE TABLE IF NOT EXISTS "CrmActivity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" "CrmActivityEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmActivity_organizationId_entityType_entityId_createdAt_idx"
    ON "CrmActivity" ("organizationId", "entityType", "entityId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmActivity_organizationId_createdAt_idx"
    ON "CrmActivity" ("organizationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
