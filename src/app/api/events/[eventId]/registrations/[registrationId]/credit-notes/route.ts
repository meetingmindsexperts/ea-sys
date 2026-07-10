import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { issueCreditNoteForRegistration, type IssueCreditNoteErrorCode } from "@/services/payment-service";

/**
 * Issue a credit note (full OR partial) for a paid registration — the organizer
 * action that MUST precede "Issue Refund". Domain logic lives in
 * `issueCreditNoteForRegistration` (payment-service); this route handles auth,
 * rate limiting, event access, body parsing, and result→HTTP mapping.
 *
 * Finance action → denyReviewer (blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER
 * write) + denyFinance (blocks MEMBER money visibility). Event lookup is routed
 * through buildEventAccessWhere so an ONSITE/cross-event caller can't credit
 * another event's registration.
 */

const bodySchema = z.object({
  /** Credit-note amount (tax-inclusive). Omit for the full outstanding amount. */
  amount: z.number().positive().max(1_000_000).optional(),
  reason: z.string().trim().max(500).optional(),
  /** Email the credit note to the registrant on issue. */
  send: z.boolean().optional(),
});

const HTTP_STATUS_FOR_CODE: Record<IssueCreditNoteErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  NOT_PAID: 400,
  INVALID_AMOUNT: 400,
  CREDIT_LIMIT_EXCEEDED: 400,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    apiLogger.warn({ msg: "credit-notes:unauthenticated" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyReviewer(session);
  if (denied) return denied;
  const financeDenied = denyFinance(session);
  if (financeDenied) return financeDenied;

  const rl = checkRateLimit({ key: `credit-note-issue:${session.user.id}`, limit: 60, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "credit-notes:rate-limited", eventId, registrationId, retryAfterSeconds: rl.retryAfterSeconds });
    return NextResponse.json(
      { error: "Too many attempts. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    apiLogger.warn({ msg: "credit-notes:invalid-input", eventId, registrationId, errors: parsed.error.flatten() });
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const event = await db.event.findFirst({
    where: { id: eventId, ...buildEventAccessWhere(session.user) },
    select: { id: true },
  });
  if (!event) {
    apiLogger.warn({ msg: "credit-notes:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const result = await issueCreditNoteForRegistration({
    registrationId,
    eventId,
    organizationId: session.user.organizationId!,
    amount: parsed.data.amount,
    reason: parsed.data.reason,
    send: parsed.data.send,
    source: "rest",
    issuedByUserId: session.user.id,
  });

  if (!result.ok) {
    apiLogger.warn({ msg: "credit-notes:rejected", eventId, registrationId, code: result.code });
    return NextResponse.json(
      { error: result.message, code: result.code, ...(result.meta ?? {}) },
      { status: HTTP_STATUS_FOR_CODE[result.code] },
    );
  }

  return NextResponse.json(result.creditNote);
}
