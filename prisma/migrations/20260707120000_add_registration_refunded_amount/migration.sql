-- Additive, blue-green safe. Running total refunded (partial refunds accumulate).
ALTER TABLE "Registration"
  ADD COLUMN IF NOT EXISTS "refundedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
