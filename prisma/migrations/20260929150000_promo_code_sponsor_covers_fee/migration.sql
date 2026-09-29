-- A sponsor's promo code can cover the fee (Sep 29, 2026): registrations made
-- with it are saved INCLUSIVE and attributed to the code's sponsor.
-- Additive, defaulted, idempotent: existing codes keep today's behaviour.
ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "sponsorCoversFee" BOOLEAN NOT NULL DEFAULT false;
