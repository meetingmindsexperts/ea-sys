-- Add organizer-authored rich-text intro for the public survey form.
--
-- Single additive change — existing rows default NULL (the public form
-- falls back to its default intro copy), so this is deploy-safe alongside
-- the running web + worker containers. Mirrors the other per-event
-- *Html Text columns (registrationWelcomeHtml, speakerAgreementHtml, …).

ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "surveyIntroHtml" TEXT;
