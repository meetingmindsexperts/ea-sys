-- CreateEnum
CREATE TYPE "ApiKeyRateLimitTier" AS ENUM ('NORMAL', 'INTERNAL');

-- AlterTable
ALTER TABLE "ApiKey"
  ADD COLUMN "rateLimitTier" "ApiKeyRateLimitTier" NOT NULL DEFAULT 'NORMAL';
