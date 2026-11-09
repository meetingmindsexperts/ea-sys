-- AccountProfile.signedUpAt (portal review, Nov 9, 2026): set only when the
-- account was made at /signup. THE marker that it must confirm its address
-- before signing in and that the 30-day prune may consider it; never inferred
-- from what the account owns (a non-attending group coordinator owns no
-- registration and was locked out by that inference).
-- Its own migration because 20261109120000 had already been pushed.
-- Additive and nullable: blue/green safe, the previous image never reads it.
-- Idempotent: safe to re-run.

ALTER TABLE "AccountProfile" ADD COLUMN IF NOT EXISTS "signedUpAt" TIMESTAMP(3);
