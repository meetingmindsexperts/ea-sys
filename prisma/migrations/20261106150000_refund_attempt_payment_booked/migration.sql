-- RefundAttempt.paymentBooked (security audit W0-1 follow-up, Nov 6, 2026).
-- Marks attempts whose booking also raised Payment.refundedAmount, so a rollback
-- of an attempt written by the previous image (which booked only the
-- registration) never takes the payment counter down.
-- Additive with a default: blue/green safe, because the previous image neither
-- reads nor writes the column and every row it creates gets false, which is
-- correct for it. Idempotent: safe to re-run.

ALTER TABLE "RefundAttempt" ADD COLUMN IF NOT EXISTS "paymentBooked" BOOLEAN NOT NULL DEFAULT false;
