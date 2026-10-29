import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import {
  MANUAL_PAYMENT_EVENT_SELECT,
  recordManualPayment,
  type RecordManualPaymentErrorCode,
} from "@/services/payment-service";

/**
 * POST /api/events/[eventId]/registrations/[registrationId]/payments
 *
 * Records a MANUAL payment for a registration — for onsite/offline
 * scenarios that bypass Stripe:
 *
 *   - bank_transfer  organizer captures the bank reference + uploaded
 *                    proof (transfer copy / receipt photo)
 *   - card_onsite    organizer captures last4 + brand of a card swiped
 *                    on a physical terminal at the desk
 *   - cash           organizer notes who received the cash
 *
 * The capture itself (the PAID flip only when the total is covered, the
 * documents, audit and admin notification) is `recordManualPayment()` in
 * src/services/payment-service.ts, shared with the onsite desk walk-in. This
 * route owns auth, the rate limit, validation and the HTTP mapping.
 *
 * Returns 409 if the registration is already PAID with a Payment row —
 * admins should never double-record. To correct a mistake, refund first,
 * then re-record. Rate-limited 60/hr per user.
 */

const recordPaymentSchema = z
  .object({
    method: z.enum(["bank_transfer", "card_onsite", "cash"]),
    amount: z.number().positive().max(1_000_000).optional(),
    currency: z.string().length(3).toUpperCase().optional(),
    paidAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),

    // bank_transfer
    bankReference: z.string().max(255).optional(),
    proofUrl: z.string().max(2000).optional(),

    // card_onsite — `cardBrand` is free-text because terminal receipts
    // don't always emit normalized strings (we'll see "VISA", "Visa",
    // "visa", "mastercard"…). The PDF renderer titlecases at display.
    cardBrand: z.string().max(50).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),

    // cash
    cashReceivedBy: z.string().max(255).optional(),

    notes: z.string().max(2000).optional(),
  })
  // Per-method required fields — caught here so the UI gets a clean
  // field-level error rather than a generic "Invalid input".
  .superRefine((data, ctx) => {
    if (data.method === "card_onsite" && !data.cardLast4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cardLast4"],
        message: "Last 4 digits of the card are required for onsite card payments",
      });
    }
    if (data.method === "cash" && !data.cashReceivedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cashReceivedBy"],
        message: "Who received the cash? (organizer / cashier name)",
      });
    }
  });

const HTTP_STATUS_FOR_PAYMENT_ERROR: Record<RecordManualPaymentErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  ALREADY_PAID: 409,
  ZERO_AMOUNT: 400,
  INVALID_PAID_AT: 400,
  LOST_RACE: 409,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  let registrationId: string | undefined;
  let eventId: string | undefined;
  try {
    const [{ eventId: eId, registrationId: rId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);
    eventId = eId;
    registrationId = rId;

    if (!session?.user) {
      apiLogger.warn({ msg: "manual-payment:unauthenticated", eventId, registrationId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Registration-desk roles (ONSITE + MEMBER) can record a payment.
    const gate = requirePermission(session, "payments.record", { route: "events/[eventId]/registrations/[registrationId]/payments:POST", eventId });
    if (!gate.ok) return gate.response;

    // The widest money-write population of any endpoint (desk temps included)
    // had no rate limit (review H7). 60/hr is far above any real desk pace.
    const rateLimit = checkRateLimit({
      key: `manual-payment:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "manual-payment:rate-limited", eventId, registrationId, userId: session.user.id });
      return NextResponse.json(
        { error: "Too many payment recordings. Please wait before recording more.", retryAfterSeconds: rateLimit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const parsed = recordPaymentSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "manual-payment:zod-validation-failed",
        eventId,
        registrationId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: MANUAL_PAYMENT_EVENT_SELECT,
    });
    if (!event) {
      apiLogger.warn({
        msg: "manual-payment:event-not-found",
        eventId,
        registrationId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // The capture, its documents, audit and notification live in
    // payment-service (shared with the onsite desk walk-in). Tenancy sweep
    // (B-1 fix): run it inside the event's org; passthrough on master.
    const result = await runWithTenant(event.organizationId, () =>
      recordManualPayment({
        event,
        registrationId: registrationId!,
        ...data,
        recordedByUserId: session.user.id,
        requestIp: getClientIp(req),
        source: "rest",
      }),
    );
    if (!result.ok) {
      // The service logged the rejection with its own context.
      return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS_FOR_PAYMENT_ERROR[result.code] });
    }
    return NextResponse.json(result.summary);
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "manual-payment:unexpected-error",
      eventId,
      registrationId,
      prismaCode: (error as { code?: string })?.code ?? null,
    });
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  }
}
