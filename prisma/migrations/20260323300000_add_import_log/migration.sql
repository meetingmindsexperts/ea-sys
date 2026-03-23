-- CreateTable (idempotent for dual-deployment safety)
CREATE TABLE IF NOT EXISTS "ImportLog" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "totalProcessed" INTEGER NOT NULL,
    "totalCreated" INTEGER NOT NULL,
    "totalSkipped" INTEGER NOT NULL,
    "totalErrors" INTEGER NOT NULL,
    "skippedDetails" JSONB NOT NULL DEFAULT '[]',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportLog_pkey" PRIMARY KEY ("id")
);

-- Indexes (use CREATE INDEX IF NOT EXISTS per dual-deploy rules)
CREATE INDEX IF NOT EXISTS "ImportLog_eventId_idx" ON "ImportLog"("eventId");
CREATE INDEX IF NOT EXISTS "ImportLog_createdAt_idx" ON "ImportLog"("createdAt");

-- Foreign key
DO $$
BEGIN
    ALTER TABLE "ImportLog" ADD CONSTRAINT "ImportLog_eventId_fkey"
        FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
