-- Watch analytics on our own webinar page (Nov 23, 2026): the device, browser
-- and system each attendee watched on, how they watched (our stream or the Zoom
-- embed), how the stream played for them (buffering and reconnects), and the
-- minutes they were watching, for the console's watching-over-time chart.
--
-- Additive and idempotent: columns with defaults, each guarded so a re-run is a
-- no-op. The container still running the previous image never reads or writes
-- them, and its inserts get the defaults. No backfill: past webinars have no
-- record of any of this. Only the parsed device, browser and system are kept,
-- never the user agent text or an address.
--
-- The heartbeat writes this table about 150 times a second during a large
-- webinar: a lock wait (the hourly backup dump holds a share lock) must fail
-- fast instead of queueing every heartbeat behind the ALTER. A run that times
-- out is simply run again.

SET lock_timeout = '10s';

ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "deviceType" TEXT;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "browser" TEXT;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "os" TEXT;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "viewMode" TEXT;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "stallCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "stallSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "reconnectCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebinarPresence" ADD COLUMN IF NOT EXISTS "watchedMinutes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
