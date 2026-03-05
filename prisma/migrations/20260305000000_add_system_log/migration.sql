-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "SystemLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "SystemLog_timestamp_idx" ON "SystemLog"("timestamp");
CREATE INDEX IF NOT EXISTS "SystemLog_level_idx" ON "SystemLog"("level");
CREATE INDEX IF NOT EXISTS "SystemLog_module_idx" ON "SystemLog"("module");
