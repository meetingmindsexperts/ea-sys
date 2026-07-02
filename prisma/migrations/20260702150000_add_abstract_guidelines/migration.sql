-- Add abstractGuidelinesHtml to Event (editable-per-event abstract submission
-- guidelines shown on the submission form + submitter profile page).
-- Additive + idempotent → blue-green safe (old code ignores the column).
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "abstractGuidelinesHtml" TEXT;
