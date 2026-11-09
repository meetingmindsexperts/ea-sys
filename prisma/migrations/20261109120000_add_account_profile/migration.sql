-- AccountProfile: a person's own details on their account, and marketing consent
-- (Nov 9, 2026, docs/ACCOUNT_SIGNUP_PLAN.md). One row per User, keyed by userId.
-- A new table only: blue/green safe, because the previous image never reads it.
-- No organizationId and no RLS policy, like "User". Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "AccountProfile" (
    "userId" TEXT NOT NULL,
    "title" "Title",
    "role" "AttendeeRole",
    "organization" TEXT,
    "jobTitle" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "country" TEXT,
    "specialty" TEXT,
    "customSpecialty" TEXT,
    "marketingConsentAt" TIMESTAMP(3),
    "marketingConsentIp" TEXT,
    "marketingConsentWording" TEXT,
    "marketingConsentWithdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountProfile_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AccountProfile_userId_fkey') THEN
    ALTER TABLE "AccountProfile"
      ADD CONSTRAINT "AccountProfile_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
