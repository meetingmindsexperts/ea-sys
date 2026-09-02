-- Per-registration-type identity-evidence switches (Sept 2, 2026).
--
-- Replaces a name match: a type whose name contained "member" asked for a
-- membership number, one containing "student" asked for a student ID + expiry.
-- That made verification invisible (rename the type and it silently stops),
-- accidental ("Trainee / Student" matched only because of the slash), and
-- incomplete ("Resident", the most-registered type in the family across 19
-- events, matched nothing and so asked for nothing).
--
-- ADDITIVE + IDEMPOTENT. The backfill is GATED on the first column not
-- existing, so it runs EXACTLY ONCE. A bare `WHERE requiresStudentId = false`
-- would be re-runnable but would also re-enable a type an organizer had
-- deliberately switched off later, which is worse than not being idempotent.
DO $$
DECLARE
  needs_backfill boolean;
BEGIN
  needs_backfill := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TicketType' AND column_name = 'requiresMemberId'
  );

  ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "requiresMemberId"        BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "requiresStudentId"       BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "requiresStudentIdExpiry" BOOLEAN NOT NULL DEFAULT false;

  IF needs_backfill THEN
    -- EXACT PARITY with the name match being retired: every type that asks
    -- today keeps asking, and nothing that stays silent today starts.
    --
    -- Deliberately NOT extended to "Resident" and friends. Turning verification
    -- ON for 19 live events is a behaviour change nobody asked for; the whole
    -- point is that an organizer can now switch it on themselves, per event,
    -- and see that they have.
    UPDATE "TicketType" SET "requiresMemberId" = true
      WHERE lower(name) LIKE '%member%';

    UPDATE "TicketType"
       SET "requiresStudentId" = true, "requiresStudentIdExpiry" = true
      WHERE lower(name) LIKE '%student%';
  END IF;
END $$;
