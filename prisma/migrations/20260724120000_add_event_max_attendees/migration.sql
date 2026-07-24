-- Event-wide attendee cap (Option B, July 24, 2026).
--
-- "maxAttendees": null = unlimited. Deliberately NOT backfilled from the
-- legacy settings.maxAttendees JSON key — that input was never enforced, so
-- silently activating a forgotten number could block a live event's
-- registration. Organizers re-enter the cap deliberately in Settings, and the
-- save recomputes "seatCount" from row-truth in the same transaction.
--
-- "seatCount": the enforcement counter (mirrors TicketType.soldCount).
-- Starts at 0 everywhere; accuracy is guaranteed by the recompute-on-set in
-- the event PUT, not by a backfill here.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) — blue-green safe: old
-- containers ignore both columns.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "maxAttendees" INTEGER;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "seatCount" INTEGER NOT NULL DEFAULT 0;
