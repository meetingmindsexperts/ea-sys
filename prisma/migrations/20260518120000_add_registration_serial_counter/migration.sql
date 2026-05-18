-- Atomic per-event registration serial counter.
--
-- Replaces the racy `aggregate(_max: serialId) + 1` in
-- src/lib/registration-serial.ts. A MAX() aggregate takes no row lock under
-- Read Committed, so two concurrent registrations for the same event both
-- read the same max and computed the same serialId; one then hit P2002 on
-- @@unique([eventId, serialId]) and the public register route surfaced it
-- to a legitimate first-time registrant as a misleading "You are already
-- registered for this event" error.
--
-- The upsert+increment on this table compiles to
-- `INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial + 1`,
-- which takes a row lock and serializes concurrent registrations.
--
-- Additive + backfilled, so it is blue-green deploy safe: the old container
-- (still serving traffic while `prisma migrate deploy` runs) keeps using the
-- old MAX+1 path against an untouched Registration table. We seed lastSerial
-- to the CURRENT max (not max+1), so the first new-code increment yields
-- max+1 — identical to what the old code would have produced, eliminating
-- collision risk across the brief cutover window; the @@unique constraint
-- remains the final safety net.

CREATE TABLE "RegistrationSerialCounter" (
    "eventId" TEXT NOT NULL,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RegistrationSerialCounter_pkey" PRIMARY KEY ("eventId")
);

-- Backfill one row per event that already has registrations.
-- Events with no registrations (or created later) get their row lazily via
-- the upsert's create path on first registration.
INSERT INTO "RegistrationSerialCounter" ("eventId", "lastSerial")
SELECT "eventId", COALESCE(MAX("serialId"), 0)
FROM "Registration"
GROUP BY "eventId";

ALTER TABLE "RegistrationSerialCounter"
    ADD CONSTRAINT "RegistrationSerialCounter_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
