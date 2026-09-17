-- Organizer-editable thank-you message on the public survey page.
--
-- Single additive, nullable column: every existing event keeps NULL, which the
-- page renders as the default thank-you copy. Deploy-safe alongside the running
-- containers, since the old code never selects it.
--
-- Event.surveyShareLink is deliberately NOT dropped although the shareable link
-- was retired the same day: dropping a column is destructive and not blue/green
-- safe (the old container still selects it until the swap). It stays, unread.

ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "surveyThankYouHtml" TEXT;
