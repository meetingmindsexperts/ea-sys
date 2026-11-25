-- An RSVP's own question, the line under it, and its thank-you (Nov 25, 2026).
--
-- Owner: "give text boxes for organizer to add" the "Will you be attending?"
-- heading and the "Tick the box if you'll join..." line on the invitee's page,
-- and "thank you text also": the message shown once they have answered.
-- Null means the built-in wording (the question and its line follow the RSVP's
-- shape: one option or several, pick one or pick many). Additive and nullable: an older image
-- never reads the columns, so a rollback shows the built-in wording again.
-- Idempotent: a second run changes nothing.
--
-- RsvpCampaign is a small table (one row per RSVP), but ADD COLUMN still takes
-- its strongest lock: give up after 10 seconds rather than queue behind a long
-- read (a failed migrate deploy leaves the old slot serving; mark it rolled
-- back with `prisma migrate resolve` and run it again).
SET lock_timeout = '10s';

ALTER TABLE "RsvpCampaign" ADD COLUMN IF NOT EXISTS "questionText" TEXT;
ALTER TABLE "RsvpCampaign" ADD COLUMN IF NOT EXISTS "questionHelpText" TEXT;
ALTER TABLE "RsvpCampaign" ADD COLUMN IF NOT EXISTS "thankYouText" TEXT;
