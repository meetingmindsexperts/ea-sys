-- When the stream server was last CONFIRMED to hold no recording setting for a
-- closed recording (Nov 24, 2026; review of 7563027f7). Closing a recording
-- removes its stream's setting from the stream server. When that call failed,
-- the minute sweep tried again for one hour and then gave up, so a setting
-- saying "record" could outlive its recording for as long as the stream server
-- ran. With this timestamp the sweep keeps trying until a clear is confirmed,
-- and then stops asking.
--
-- Additive and idempotent: one nullable column on a table nothing writes to in
-- production yet. The container still running the previous image never reads it.
SET lock_timeout = '10s';

ALTER TABLE "StreamRecording" ADD COLUMN IF NOT EXISTS "serverClearedAt" TIMESTAMP(3);
