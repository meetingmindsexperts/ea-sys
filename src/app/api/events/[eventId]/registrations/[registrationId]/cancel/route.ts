import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { cancelRegistration, type CancelRegistrationErrorCode } from "@/services/payment-service";

/**
 * Cancel a registration, optionally auto-refunding a paid one.
 *
 * `{ refund: true }` → for a PAID registration, auto-issue a full credit note +
 * refund the remaining balance FIRST, then cancel (release seat + promo). If the
 * refund fails, the registration is NOT cancelled (recoverable). `{ refund:
 * false }` (or a non-paid reg) → just cancel.
 *
 * Finance action → denyReviewer (blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER +
 * ONSITE) + denyFinance. Event access via buildEventAccessWhere.
 */

const bodySchema = z.object({
  refund: z.boolean().optional().default(false),
});

const HTTP_STATUS_FOR_CODE: Record<CancelRegistrationErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  ALREADY_CANCELLED: 409,
  REFUND_FAILED: 502,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyReviewer(session);
  if (denied) return denied;
  const financeDenied = denyFinance(session);
  if (financeDenied) return financeDenied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    apiLogger.warn({ msg: "cancel:invalid-input", eventId, registrationId, errors: parsed.error.flatten() });
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const event = await db.event.findFirst({
    where: { id: eventId, ...buildEventAccessWhere(session.user) },
    select: { id: true },
  });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  apiLogger.info({ msg: "Cancel requested", registrationId, eventId, refund: parsed.data.refund, issuedBy: session.user.id });

  const result = await cancelRegistration({
    registrationId,
    eventId,
    organizationId: session.user.organizationId!,
    refund: parsed.data.refund,
    source: "rest",
    issuedByUserId: session.user.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code, ...(result.meta ?? {}) },
      { status: HTTP_STATUS_FOR_CODE[result.code] },
    );
  }

  return NextResponse.json(result.cancel);
}
