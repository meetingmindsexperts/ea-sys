-- Which public self-signup flow created this submitter-speaker
-- ("abstract" | "proposal"; null = legacy/organizer-added). Drives the
-- submitter surface separation. Additive + idempotent — blue-green safe.
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "submitterSource" TEXT;
