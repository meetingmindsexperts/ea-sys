-- Optional pointer from an imported Speaker to its source Registration.
-- Fully additive + idempotent → blue-green safe (the running container
-- ignores the new column; the first new-code write/read uses it). Null for
-- independent / manually-added speakers (a speaker is a first-class entity
-- and need not be a registrant).

ALTER TABLE "Speaker"
  ADD COLUMN IF NOT EXISTS "sourceRegistrationId" TEXT;

-- SetNull: deleting the registration must NOT delete the speaker.
DO $$ BEGIN
  ALTER TABLE "Speaker" ADD CONSTRAINT "Speaker_sourceRegistrationId_fkey"
    FOREIGN KEY ("sourceRegistrationId") REFERENCES "Registration"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Speaker_sourceRegistrationId_idx"
  ON "Speaker"("sourceRegistrationId");
