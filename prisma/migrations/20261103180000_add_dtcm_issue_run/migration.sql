-- DtcmIssueRun (Nov 3, 2026; docs/DTCM_ETICKET_PLAN.md step 4): one bulk
-- "Generate DTCM codes" run per row, worked by the dtcm-issue worker job.
-- Progress is counted from DtcmOrder.runId, so the run stores no counters.
-- Additive and idempotent: one new enum, one new table, nothing existing
-- touched. RLS policy in prisma/rls/dtcmissuerun.sql (platform instance
-- only). No rollback hazard: an older image never reads the table.

DO $$ BEGIN
  CREATE TYPE "DtcmIssueRunStatus" AS ENUM ('RUNNING', 'STOPPED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "DtcmIssueRun" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "environment" TEXT NOT NULL,
    "performanceCode" TEXT NOT NULL,
    "status" "DtcmIssueRunStatus" NOT NULL DEFAULT 'RUNNING',
    "activeKey" TEXT,
    "expected" INTEGER NOT NULL,
    "soldOutAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stopReason" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTickAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DtcmIssueRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DtcmIssueRun_activeKey_key" ON "DtcmIssueRun"("activeKey");
CREATE INDEX IF NOT EXISTS "DtcmIssueRun_eventId_createdAt_idx" ON "DtcmIssueRun"("eventId", "createdAt");
CREATE INDEX IF NOT EXISTS "DtcmIssueRun_status_idx" ON "DtcmIssueRun"("status");
CREATE INDEX IF NOT EXISTS "DtcmIssueRun_organizationId_idx" ON "DtcmIssueRun"("organizationId");

DO $$ BEGIN
  ALTER TABLE "DtcmIssueRun" ADD CONSTRAINT "DtcmIssueRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
