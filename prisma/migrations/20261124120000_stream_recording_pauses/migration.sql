-- Every pause of a recording, not only the last (Nov 24, 2026; review of
-- 9592d2151). The shipping job deletes, unshipped, any piece the stream server
-- recorded while the organisers had recording stopped: a Stop the stream server
-- was told about late. With only the last pause known, footage from an earlier
-- pause became "wanted" again after a later Stop and was shipped, out of order,
-- into the client's archive; and a Finish after a pause forgot the pause.
--
-- A JSON list of {"from": ISO time, "to": ISO time or null}, the open one last.
--
-- Additive and idempotent: one column with a default on a table nothing writes
-- to in production yet. The container still running the previous image never
-- reads it, and its writes get the default.
SET lock_timeout = '10s';

ALTER TABLE "StreamRecording" ADD COLUMN IF NOT EXISTS "pauses" JSONB NOT NULL DEFAULT '[]';
