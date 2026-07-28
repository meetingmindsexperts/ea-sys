-- Login activity tracking: who signed in, when, from where.
--
-- Fully ADDITIVE and IDEMPOTENT (new enums + new table + new indexes only), so
-- it is safe under blue-green: the old container simply never writes to it.
-- Nothing existing is altered, so there is no backfill and no rollback risk.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoginOutcome') THEN
    CREATE TYPE "LoginOutcome" AS ENUM (
      'SUCCESS',
      'FAILED_PASSWORD',
      'FAILED_UNKNOWN_EMAIL',
      'BLOCKED_RATE_LIMIT'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoginSurface') THEN
    CREATE TYPE "LoginSurface" AS ENUM ('DASHBOARD', 'EVENT_PAGE', 'MOBILE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "LoginEvent" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT,
  "organizationId" TEXT,
  "email"          TEXT NOT NULL,
  "outcome"        "LoginOutcome" NOT NULL,
  "surface"        "LoginSurface" NOT NULL DEFAULT 'DASHBOARD',
  "ipAddress"      TEXT,
  "userAgent"      TEXT,
  "geoCity"        TEXT,
  "geoCountry"     TEXT,
  "geoResolvedAt"  TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LoginEvent_organizationId_createdAt_idx"
  ON "LoginEvent" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_userId_createdAt_idx"
  ON "LoginEvent" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_email_createdAt_idx"
  ON "LoginEvent" ("email", "createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_ipAddress_createdAt_idx"
  ON "LoginEvent" ("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS "LoginEvent_createdAt_idx"
  ON "LoginEvent" ("createdAt");

-- SET NULL on both parents: deleting a user or an organization must never
-- destroy the security record of how their account was accessed, and must
-- never be BLOCKED by it either.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LoginEvent_userId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent"
      ADD CONSTRAINT "LoginEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LoginEvent_organizationId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent"
      ADD CONSTRAINT "LoginEvent_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
