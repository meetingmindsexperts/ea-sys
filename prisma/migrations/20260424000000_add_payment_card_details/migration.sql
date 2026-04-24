-- Add card / payment-instrument detail columns to Payment so the
-- post-payment Invoice PDF + the Billing tab on the registration
-- detail sheet can render "Paid via Visa ending 4242 on 2026-04-24".
-- All columns nullable so legacy rows (pre-capture) remain valid.
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "cardBrand"         TEXT,
  ADD COLUMN IF NOT EXISTS "cardLast4"         TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethodType" TEXT,
  ADD COLUMN IF NOT EXISTS "paidAt"            TIMESTAMP(3);
