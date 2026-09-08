-- Sep 8, 2026: configurable reimbursement types. Which claim items a speaker
-- may claim on the reimbursement form (subset of SPEAKER_FEE | FLIGHT | HOTEL |
-- TRANSPORT | OTHER). NULL = inherit the event default held in
-- Event.settings.reimbursement.claimItems (absent there = all five), so no
-- existing speaker or event changes behaviour. Additive + idempotent.
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "reimbursementClaimItems" JSONB;
