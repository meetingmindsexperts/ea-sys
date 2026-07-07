-- Optional phone/tablet banner (art-direction). Additive + idempotent so it's
-- blue-green safe: the old container ignores the column, the new one reads it.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "bannerImageMobile" TEXT;
