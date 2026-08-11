-- Session revocation counter for stateless JWT sessions.
--
-- Additive + idempotent + blue-green safe: NOT NULL with a DEFAULT, so rows
-- created by the OLD container (which does not know the column) still get 0,
-- and 0 is exactly what an existing token carries once the new code stamps it.
-- Nobody is signed out by this deploy.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
