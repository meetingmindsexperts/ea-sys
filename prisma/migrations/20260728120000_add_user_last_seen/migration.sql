-- "Who is logged in right now" — last-seen activity tracking.
--
-- Sessions in this product are stateless JWTs (`strategy: "jwt"`), so there is
-- no server-side session record to enumerate. This nullable scalar is the
-- pragmatic answer: stamped at most once every 5 minutes from the NextAuth JWT
-- callback, "online now" is a recent value.
--
-- Fully ADDITIVE and IDEMPOTENT (one nullable column + one index), so it is safe
-- under blue-green: the old container simply never writes it, and every existing
-- row starts NULL, which reads as "never seen since this shipped".

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_organizationId_lastSeenAt_idx"
  ON "User" ("organizationId", "lastSeenAt");
