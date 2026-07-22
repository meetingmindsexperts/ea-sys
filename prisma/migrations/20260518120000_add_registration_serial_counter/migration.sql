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
-- max+1 — identical to what the old code would have produced. This makes
-- the steady state collision-free. There is still a bounded one-shot window
-- during the old→new container overlap: if a registration completes on the
-- OLD container after the counter is seeded, old code writes MAX+1 to
-- Registration without touching the counter, and the new code's first
-- upsert then also yields MAX+1. That single race is caught by the
-- @@unique([eventId, serialId]) constraint (P2002, tx rollback, no
-- corruption) and self-heals on the next increment — strictly better than
-- the pre-fix behavior where the race existed in steady state.

CREATE TABLE "RegistrationSerialCounter" (
    "eventId" TEXT NOT NULL,
    "lastSerial" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RegistrationSerialCounter_pkey" PRIMARY KEY ("eventId")
);

-- Backfill one row per event that already has registrations.
-- Events with no registrations (or created later) get their row lazily via
-- the upsert's create path on first registration.
--
-- FRESH-REPLAY GUARD (edited July 22, 2026 — behavior-invisible on prod):
-- "Registration"."serialId" was added to prod via `db push` and is not
-- created by any migration in the chain (it lands in the July 22 corrective
-- sync migration, which is dated AFTER this one). On a fresh database the
-- column therefore doesn't exist yet at this point — and there are no
-- registrations to backfill anyway — so the INSERT is skipped. On prod this
-- migration is already applied and `migrate deploy` skips it by name, so the
-- edit changes nothing there.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Registration'
          AND column_name = 'serialId'
    ) THEN
        INSERT INTO "RegistrationSerialCounter" ("eventId", "lastSerial")
        SELECT "eventId", COALESCE(MAX("serialId"), 0)
        FROM "Registration"
        GROUP BY "eventId";
    END IF;
END $$;

ALTER TABLE "RegistrationSerialCounter"
    ADD CONSTRAINT "RegistrationSerialCounter_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
