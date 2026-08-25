-- DTCM code pool (Aug 25, 2026).
--
-- Spare compliance codes the organiser holds but has not handed to anyone.
-- `Registration.dtcmBarcode` can only hold a code that already belongs to a
-- person; the leftovers from the pre-event block have nowhere to live, and
-- they are exactly what the desk needs for walk-ups on the day.
--
-- ADDITIVE + IDEMPOTENT: one new table, no column changes, no constraint
-- changes anywhere else. `Registration.dtcmBarcode` keeps its global UNIQUE —
-- it is still the one thing that grants entry, and nothing here loosens it.
-- Blue-green safe: the old container never reads this table.

CREATE TABLE IF NOT EXISTS "DtcmCode" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "code" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT,

    CONSTRAINT "DtcmCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DtcmCode_eventId_code_key" ON "DtcmCode"("eventId", "code");
CREATE INDEX IF NOT EXISTS "DtcmCode_eventId_idx" ON "DtcmCode"("eventId");
CREATE INDEX IF NOT EXISTS "DtcmCode_organizationId_idx" ON "DtcmCode"("organizationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DtcmCode_eventId_fkey'
  ) THEN
    ALTER TABLE "DtcmCode"
      ADD CONSTRAINT "DtcmCode_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
