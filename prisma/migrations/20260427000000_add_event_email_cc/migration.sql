-- Add `emailCcAddresses` array to Event so organizers can opt in to
-- automatic CC on every event-scoped email (confirmations, invites,
-- bulk email, manual single-sends). Defaults to empty so existing
-- events keep the previous "no CC" behaviour.
ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "emailCcAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
