-- Open Stripe Checkout session pointer (review H2 sub-item) — stored at
-- session create so cancelling a registration can expire the still-open
-- payment tab. Additive + idempotent + blue-green safe.

ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "stripeCheckoutSessionId" TEXT;
