-- Additive, blue-green safe. Dedicated Stripe receipt URL + local snapshot path.
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "stripeReceiptUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeReceiptFile" TEXT;
