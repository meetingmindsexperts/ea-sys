-- Add REGISTRANT to UserRole enum
DO $$ BEGIN
  ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'REGISTRANT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add userId to Registration (nullable FK to User)
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- Add FK constraint
DO $$ BEGIN
  ALTER TABLE "Registration" ADD CONSTRAINT "Registration_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Index for userId lookups
CREATE INDEX IF NOT EXISTS "Registration_userId_idx" ON "Registration"("userId");
