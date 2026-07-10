import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { refundRegistration, type RefundErrorCode } from "@/services/payment-service";

const bodySchema = z.object({
  /** Refund amount (tax-inclusive). Omit to refund the full remaining balance. */
  amount: z.number().positive().max(1_000_000).optional(),
});

/** Map the payment-service refund error code to an HTTP status. */
const HTTP_STATUS_FOR_CODE: Record<RefundErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  NOT_PAID: 400,
  CREDIT_NOTE_REQUIRED: 409,
  ALREADY_FULLY_REFUNDED: 400,
  INVALID_AMOUNT: 400,
  LOST_LOCK: 409,
  STRIPE_FAILED: 502,
  // Some slices refunded, one failed — the failed remainder was released;
  // retry refunds the rest.
  REFUND_PARTIALLY_COMPLETED: 502,
  // Booked but unconfirmable with Stripe — the reconciliation sweep resolves
  // it within ~10 min; the message tells the operator not to retry blindly.
  REFUND_STATE_UNKNOWN: 502,
  UNKNOWN: 500,
};

/**
 * Issue a refund — full OR partial — for a paid registration. Domain logic lives
 * in `refundRegistration` (payment-service); this route handles auth, event
 * access, body parsing, and result→HTTP mapping.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string; registrationId: string }> }
) {
  const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    apiLogger.warn({ msg: "refund:unauthenticated" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = denyReviewer(session);
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    apiLogger.warn({ msg: "refund:invalid-input", eventId, registrationId, errors: parsed.error.flatten() });
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  // Event access (org-scoped / assignment-gated) before touching the registration.
  const event = await db.event.findFirst({
    where: { id: eventId, ...buildEventAccessWhere(session.user) },
    select: { id: true },
  });
  if (!event) {
    apiLogger.warn({ msg: "refund:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  apiLogger.info({ msg: "Refund requested", registrationId, eventId, issuedBy: session.user.id });

  const result = await refundRegistration({
    registrationId,
    eventId,
    amount: parsed.data.amount,
    source: "rest",
    issuedByUserId: session.user.id,
  });

  if (!result.ok) {
    apiLogger.warn({ msg: "refund:rejected", eventId, registrationId, code: result.code });
    return NextResponse.json(
      { error: result.message, code: result.code, ...(result.meta ?? {}) },
      { status: HTTP_STATUS_FOR_CODE[result.code] },
    );
  }

  return NextResponse.json(result.refund);
}
