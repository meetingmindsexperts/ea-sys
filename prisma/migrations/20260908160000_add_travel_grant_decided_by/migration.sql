-- TravelGrant.decidedBy (Sep 8, 2026): who set the current status. Null = the
-- author through the public form; ORGANIZER:<userId> = set from the console.
-- Additive + idempotent + blue-green safe (nullable, no default, no backfill:
-- every existing row was answered by its author or is still pending).
ALTER TABLE "TravelGrant" ADD COLUMN IF NOT EXISTS "decidedBy" TEXT;
