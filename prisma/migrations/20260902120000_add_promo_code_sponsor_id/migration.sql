-- Sponsor attribution on a promo code (docs/SPONSOR_ATTRIBUTION_PLAN.md phase 1).
--
-- Additive and idempotent, so it is blue/green safe: the still-live old
-- container never selects this column, and re-running is a no-op.
--
-- A STRING, not a foreign key, deliberately. Sponsors live in
-- Event.settings.sponsors[] JSON today and Registration.sponsorId is already a
-- string pointer into that array; this matches it rather than inventing a
-- second convention. Both become real FKs in phase 2 when sponsors are promoted
-- to a table. The write paths validate it against the event's sponsor list, so
-- it is not a second UNVALIDATED pointer, which is the whole point.
--
-- Indexed because the reporting query filters on it through a relation
-- (`{ promoCode: { sponsorId } }`), and again through the group
-- (`{ group: { promoCode: { sponsorId } } }`), on a table that is small but
-- read on the public registration path.
ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "sponsorId" TEXT;
CREATE INDEX IF NOT EXISTS "PromoCode_sponsorId_idx" ON "PromoCode"("sponsorId");
