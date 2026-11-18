-- "Presented by" for the Panel Discussion and Q&A preset topics (Nov 18, 2026):
-- the organiser picks All, All Faculty or All the above instead of naming
-- speakers. Stored as a code (ALL, ALL_FACULTY, ALL_ABOVE) that
-- src/lib/session-topic-presets.ts turns into words; NULL is an ordinary
-- topic with its speakers. Text, not a Postgres enum, so a new choice or a
-- rollback never needs a type change.
--
-- Additive + idempotent + blue-green safe: one nullable column with no
-- default, so the ALTER is a catalogue change only. An image from before this
-- migration never reads or writes it; a preset topic it saves keeps the label.

SET lock_timeout = '10s';

ALTER TABLE "SessionTopic" ADD COLUMN IF NOT EXISTS "presenterLabel" TEXT;
