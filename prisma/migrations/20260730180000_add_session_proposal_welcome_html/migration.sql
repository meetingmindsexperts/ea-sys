-- Session-proposal register page welcome content (mirrors abstractWelcomeHtml).
-- Additive + idempotent — blue-green safe.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "sessionProposalWelcomeHtml" TEXT;
