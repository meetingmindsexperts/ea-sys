-- AlterTable: reuse the existing ApiKeyRateLimitTier enum (NORMAL | INTERNAL)
-- so OAuth-client tiers and API-key tiers stay perfectly aligned.
ALTER TABLE "McpOAuthClient"
  ADD COLUMN "rateLimitTier" "ApiKeyRateLimitTier" NOT NULL DEFAULT 'NORMAL';
