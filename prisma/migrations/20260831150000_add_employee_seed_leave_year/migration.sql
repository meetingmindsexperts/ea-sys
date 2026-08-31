-- HR: which leave year an employee's go-live seeds belong to.
--
-- `carryoverDays` and `openingSickUsed` are the figures typed in for the year
-- the module went live (2026 for the workbook import). Nothing recorded that
-- year, so the balance engine applied them to EVERY year: on 1 January 2027
-- every 2026 overdraft or surplus would have vanished and the opening sick
-- figure would have been charged again (review H6, Aug 31 2026). From now on
-- the seeds count in `seedLeaveYear` only, and every later year reads its
-- carry-in from `LeaveGrant`, written by the year-end roll.
--
-- FULLY ADDITIVE and idempotent: a nullable column, and a backfill that only
-- touches rows still at NULL. The backfill takes the year the row was
-- created, which is the year its seeds were typed in. Blue/green safe: the old
-- container never reads or writes the column.

ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "seedLeaveYear" INTEGER;

UPDATE "Employee"
   SET "seedLeaveYear" = EXTRACT(YEAR FROM "createdAt")::int
 WHERE "seedLeaveYear" IS NULL;
