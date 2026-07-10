-- Per-payment refunded totals (review H6/M4) — refunds allocate across
-- payments and charge.refunded reconciles per charge, not against the mixed
-- registration counter. Additive + idempotent + blue-green safe.

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "refundedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Backfill 1: fully-refunded payments. Under the old model the status flip to
-- REFUNDED meant "this payment fully returned".
UPDATE "Payment"
SET "refundedAmount" = "amount"
WHERE "status" = 'REFUNDED' AND "refundedAmount" = 0;

-- Backfill 2: single-payment registrations carrying a partial reg-level
-- refunded total — attribute it to the only payment. Multi-payment partials
-- (none known to exist pre-migration) are left at 0 and self-correct via the
-- charge.refunded reconciliation / future refunds.
UPDATE "Payment" p
SET "refundedAmount" = LEAST(r."refundedAmount", p."amount")
FROM "Registration" r
WHERE p."registrationId" = r."id"
  AND p."status" = 'PAID'
  AND p."refundedAmount" = 0
  AND r."refundedAmount" > 0
  AND (SELECT COUNT(*) FROM "Payment" p2
       WHERE p2."registrationId" = r."id" AND p2."status" IN ('PAID', 'REFUNDED')) = 1;
