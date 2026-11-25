-- A webinar viewer the organisers removed (Nov 25, 2026).
--
-- Owner: "remove someone from viewing the session if they misbehave", as
-- "block this webinar only": the registration stays as it is, and while
-- "webinarRemovedAt" is set the viewer rule lets the person into nothing on
-- the webinar. Additive and nullable: an older image never reads the columns,
-- so a rollback simply forgets the removals (the person can watch again).
-- Idempotent: a second run changes nothing.

ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "webinarRemovedAt" TIMESTAMP(3);
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "webinarRemovedById" TEXT;
