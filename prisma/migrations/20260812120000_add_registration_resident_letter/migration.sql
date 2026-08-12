-- Official letter substantiating a Resident/Trainee rate.
--
-- Additive + idempotent + blue-green safe: two nullable columns with no
-- default, so the OLD container (which selects neither) is unaffected and every
-- existing registration reads as "no letter on file". Nothing is required of
-- anyone by this deploy — whether the letter BLOCKS a registration is a
-- per-event setting that defaults to off (Event.settings.residentLetter).
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "residentLetterUrl" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "residentLetterFilename" TEXT;
