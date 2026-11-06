-- RefundAttempt.paymentBooked and bookingId (security audit W0-1 follow-up, Nov 6, 2026).
-- Marks attempts whose booking also raised Payment.refundedAmount, so a rollback
-- of an attempt written by the previous image (which booked only the
-- registration) never takes the payment counter down.
-- Additive with a default: blue/green safe, because the previous image neither
-- reads nor writes the column and every row it creates gets false, which is
-- correct for it. Idempotent: safe to re-run.

ALTER TABLE "RefundAttempt" ADD COLUMN IF NOT EXISTS "paymentBooked" BOOLEAN NOT NULL DEFAULT false;

-- RefundAttempt.bookingId: shared by every attempt of one refund booking, so the
-- sweep can tell a manual attempt whose Stripe siblings are still being sent
-- from one whose process died. Nullable: older rows keep the old rule.
ALTER TABLE "RefundAttempt" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;
CREATE INDEX IF NOT EXISTS "RefundAttempt_bookingId_idx" ON "RefundAttempt"("bookingId");

-- charge.refunded checks for a refund of ours in flight on the payment on every delivery.
CREATE INDEX IF NOT EXISTS "RefundAttempt_paymentId_status_idx" ON "RefundAttempt"("paymentId", "status");
