-- A registration type that needs a promo code to register on publicly
-- (Oct 16, 2026). Additive and idempotent; existing types default to off.
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "requiresPromoCode" BOOLEAN NOT NULL DEFAULT false;
