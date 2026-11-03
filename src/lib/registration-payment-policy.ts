import { PaymentStatus } from "@prisma/client";

/**
 * The payment statuses a person may set by hand on a registration (review
 * H12): when creating it, editing it, or through the agent. PENDING, REFUNDED
 * and FAILED are left out because the Stripe webhook and the credit-note-gated
 * refund flow own them; a bare REFUNDED flag would cook the books (refunded
 * amount 0, no credit note, no Payment flip, no audit). INCLUSIVE is in:
 * sponsor-paid registrations are tagged by the organiser, never by Stripe.
 *
 * The ONE list (dependency audit, Nov 3, 2026). It was written out four times,
 * in the registration service, the agent tools, the dashboard's enum file and
 * the registration PUT route, with a test keeping two of them in step. Client
 * safe: the Prisma enum is a plain object.
 */
export const MANUAL_PAYMENT_STATUSES = [
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PAID,
  PaymentStatus.COMPLIMENTARY,
  PaymentStatus.INCLUSIVE,
] as const;
export type ManualPaymentStatus = (typeof MANUAL_PAYMENT_STATUSES)[number];

/** For a membership test on an unvalidated string. */
export const ADMIN_SETTABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set<string>(MANUAL_PAYMENT_STATUSES);

export const PAYMENT_STATUS_WRITE_REJECTION =
  "Stripe-driven paymentStatus values (PENDING/REFUNDED/FAILED) cannot be set directly — PENDING/FAILED are owned by the payment webhook, and refunds must go through the credit-note-gated refund flow (registration Billing tab / POST …/refund) so the money actually moves.";
