-- Per-registration-type supporting document (2026-08-13).
--
-- Replaces the name-pattern trigger the Resident letter shipped with on
-- 2026-08-12 (/resident|trainee/i) with an explicit organizer flag. See
-- docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md for why: configuration encoded in a
-- NAME is configuration nobody can see, change or audit — renaming "Resident"
-- to "Junior Doctor" silently switched the requirement off, with no warning
-- and no log line.
--
-- ADDITIVE + IDEMPOTENT + blue/green safe. The whole body is gated on the
-- first column not already existing, so the BACKFILL runs exactly once: a
-- bare `UPDATE ... WHERE requiresDocument = false` would be re-runnable but
-- would also re-enable a type an organizer had deliberately switched OFF
-- later, which is worse than not being idempotent.
--
-- Registration.residentLetterUrl / residentLetterFilename are deliberately
-- NOT renamed here. Migrations run BEFORE the container swap, so an
-- ALTER ... RENAME COLUMN would leave the still-live old container querying a
-- column that no longer exists. The Prisma fields are renamed via @map
-- instead, which changes no SQL at all.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'TicketType'
       AND column_name = 'requiresDocument'
  ) THEN
    ALTER TABLE "TicketType" ADD COLUMN "requiresDocument"     BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "TicketType" ADD COLUMN "documentRequired"     BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "TicketType" ADD COLUMN "documentLabel"        TEXT;
    ALTER TABLE "TicketType" ADD COLUMN "documentInstructions" TEXT;

    -- Backfill 1: every type the old pattern matched keeps asking, with the
    -- copy that actually shipped (parity, not a paraphrase). On production
    -- this is Resident, Trainee / Student, and Student/Resident.
    UPDATE "TicketType"
       SET "requiresDocument" = true,
           "documentLabel" = 'Official Letter',
           "documentInstructions" =
             'Please upload an official letter from your current institution confirming your status as a Resident or Trainee.' ||
             chr(10) ||
             'The letter must be in English, printed on official letterhead, and signed and stamped by the relevant authority.'
     WHERE lower("name") LIKE '%resident%'
        OR lower("name") LIKE '%trainee%';

    -- Backfill 2: carry each event's existing blocking policy across, so no
    -- event's behaviour flips. The old switch was event-wide
    -- (Event.settings.residentLetter.required, default OFF); it becomes
    -- per-type here and the Settings control is retired.
    UPDATE "TicketType" t
       SET "documentRequired" = true
      FROM "Event" e
     WHERE t."eventId" = e."id"
       AND t."requiresDocument" = true
       AND (e."settings" -> 'residentLetter' ->> 'required') = 'true';
  END IF;
END $$;
