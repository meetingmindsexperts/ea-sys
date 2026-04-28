-- Adds Event.emailFooterImage — responsive logo image rendered at
-- the bottom of every event email body. Pure additive; legacy rows
-- default to NULL and the renderer skips the block when unset.
ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "emailFooterImage" TEXT;
