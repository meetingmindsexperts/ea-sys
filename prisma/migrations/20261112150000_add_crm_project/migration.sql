-- Corporate projects in the CRM (Nov 12, 2026).
--
-- The sales team sells work that is not an event in EA-SYS (a client's own
-- meeting, an advisory board). Until now a deal had to name an event, so that
-- work could not be entered. A deal is now for an event OR a corporate project.
--
-- Additive and idempotent: one new table, one new nullable column on CrmDeal,
-- their indexes and foreign keys, every statement guarded so a re-run is a
-- no-op. Nothing existing is altered or backfilled (every deal keeps its
-- event), so the container still running the previous image keeps working: it
-- never reads the column and never sees the table.
--
-- No row-level-security statement here: master holds no RLS objects. The
-- policy for the platform instance is prisma/rls/crmproject.sql.

CREATE TABLE IF NOT EXISTS "CrmProject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "companyId" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "location" TEXT,
    "ownerId" TEXT,
    "eventId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmProject_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "CrmProject_organizationId_nameKey_key" ON "CrmProject"("organizationId", "nameKey");
CREATE INDEX IF NOT EXISTS "CrmProject_organizationId_archivedAt_idx" ON "CrmProject"("organizationId", "archivedAt");
CREATE INDEX IF NOT EXISTS "CrmProject_eventId_idx" ON "CrmProject"("eventId");
CREATE INDEX IF NOT EXISTS "CrmProject_companyId_idx" ON "CrmProject"("companyId");
CREATE INDEX IF NOT EXISTS "CrmDeal_projectId_idx" ON "CrmDeal"("projectId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmProject_organizationId_fkey') THEN
    ALTER TABLE "CrmProject" ADD CONSTRAINT "CrmProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmProject_companyId_fkey') THEN
    ALTER TABLE "CrmProject" ADD CONSTRAINT "CrmProject_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmProject_ownerId_fkey') THEN
    ALTER TABLE "CrmProject" ADD CONSTRAINT "CrmProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmProject_eventId_fkey') THEN
    ALTER TABLE "CrmProject" ADD CONSTRAINT "CrmProject_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmDeal_projectId_fkey') THEN
    ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CrmProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
