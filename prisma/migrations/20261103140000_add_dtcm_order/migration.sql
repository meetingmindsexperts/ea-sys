-- DtcmOrder (Nov 3, 2026; docs/DTCM_ETICKET_PLAN.md step 3): one row per
-- attempt to buy a DTCM ticket from DET for a registration, written BEFORE the
-- DET call so a retry can never buy a second ticket (`activeKey` is unique
-- while the attempt is live). Additive and idempotent: one new enum, one new
-- table, nothing existing touched. RLS policy in prisma/rls/dtcmorder.sql
-- (platform instance only). No rollback hazard: an older image never reads
-- the table.

DO $$ BEGIN
  CREATE TYPE "DtcmOrderStatus" AS ENUM ('PENDING', 'PURCHASED', 'FAILED', 'UNCERTAIN', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "DtcmOrder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "registrationId" TEXT,
    "environment" TEXT NOT NULL,
    "status" "DtcmOrderStatus" NOT NULL DEFAULT 'PENDING',
    "activeKey" TEXT,
    "performanceCode" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "priceTypeCode" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "basketId" TEXT,
    "orderId" TEXT,
    "barcode" TEXT,
    "detCustomerId" TEXT,
    "errorStage" TEXT,
    "errorStatus" INTEGER,
    "errorMessage" TEXT,
    "runId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DtcmOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DtcmOrder_activeKey_key" ON "DtcmOrder"("activeKey");
CREATE INDEX IF NOT EXISTS "DtcmOrder_eventId_status_idx" ON "DtcmOrder"("eventId", "status");
CREATE INDEX IF NOT EXISTS "DtcmOrder_registrationId_idx" ON "DtcmOrder"("registrationId");
CREATE INDEX IF NOT EXISTS "DtcmOrder_organizationId_idx" ON "DtcmOrder"("organizationId");
CREATE INDEX IF NOT EXISTS "DtcmOrder_runId_idx" ON "DtcmOrder"("runId");

DO $$ BEGIN
  ALTER TABLE "DtcmOrder" ADD CONSTRAINT "DtcmOrder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DtcmOrder" ADD CONSTRAINT "DtcmOrder_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
