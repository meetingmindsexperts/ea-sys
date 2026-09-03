-- Speaker honorarium / speaker fee (Sep 3, 2026).
--
-- The organiser agrees a fee per speaker. The reimbursement form shows it as
-- a LOCKED "Honorarium / Speaker Fee" line the speaker can neither add nor
-- change (the public submit writes this value, never the body's), and it is
-- available as {{honorarium}} in every speaker email. It lives on Speaker
-- (already event-scoped) rather than on SpeakerReimbursement because the
-- variable must resolve in an invitation sent before any reimbursement link
-- exists. NULL = not agreed, rendered as 0. The currency is one of the
-- reimbursement currencies (USD / AED / SAR), validated at the route.
--
-- ADDITIVE + IDEMPOTENT: two nullable columns, no backfill, blue-green safe.
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "honorariumAmount" DECIMAL(12,2);
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "honorariumCurrency" TEXT;
