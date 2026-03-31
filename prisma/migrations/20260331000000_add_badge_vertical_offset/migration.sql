-- Add badgeVerticalOffset to Event (default 0)
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "badgeVerticalOffset" INTEGER NOT NULL DEFAULT 0;
