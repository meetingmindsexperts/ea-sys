import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { createCreditNote, sendInvoiceEmail, CreditNoteAmountError } from "@/lib/invoice-service";

/**
 * Issue a credit note (full OR partial) for a paid registration — the organizer
 * action that MUST precede "Issue Refund" (the refund route requires a credit
 * note to exist). Optionally emails the credit note to the registrant.
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

  try {
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

    const [event, registration] = await Promise.all([
      db.event.findFirst({ where: { id: eventId, ...buildEventAccessWhere(session.user) }, select: { id: true } }),
      db.registration.findUnique({
        where: { id: registrationId },
        select: { id: true, eventId: true, paymentStatus: true },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!registration || registration.eventId !== eventId) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }
    // A credit note only makes sense against money that was actually collected.
    if (registration.paymentStatus !== "PAID" && registration.paymentStatus !== "REFUNDED") {
      return NextResponse.json(
        { error: "A credit note can only be issued for a paid registration.", code: "NOT_PAID" },
        { status: 400 },
      );
    }

    const { invoice: cn, creditedAfter, paidTotal } = await createCreditNote({
      registrationId,
      eventId,
      organizationId: session.user.organizationId!,
      reason: parsed.data.reason,
      amount: parsed.data.amount,
    });

    if (parsed.data.send) {
      await sendInvoiceEmail(cn.id).catch((err) =>
        apiLogger.error({ err, msg: "credit-notes:send-failed", creditNoteId: cn.id, registrationId }),
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREDIT_NOTE_ISSUED",
          entityType: "Registration",
          entityId: registrationId,
          changes: {
            creditNoteId: cn.id,
            invoiceNumber: cn.invoiceNumber,
            amount: Number(cn.total),
            currency: cn.currency,
            creditedAfter,
            paidTotal,
            emailed: !!parsed.data.send,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "credit-notes:audit-write-failed", creditNoteId: cn.id }));

    apiLogger.info({
      msg: "Credit note issued",
      eventId,
      registrationId,
      creditNoteId: cn.id,
      invoiceNumber: cn.invoiceNumber,
      amount: Number(cn.total),
      creditedAfter,
      paidTotal,
      emailed: !!parsed.data.send,
      issuedBy: session.user.id,
    });

    return NextResponse.json({
      creditNoteId: cn.id,
      invoiceNumber: cn.invoiceNumber,
      amount: Number(cn.total),
      currency: cn.currency,
      creditedAfter,
      paidTotal,
      emailed: !!parsed.data.send,
    });
  } catch (err) {
    if (err instanceof CreditNoteAmountError) {
      apiLogger.warn({ msg: "credit-notes:amount-rejected", eventId, registrationId, code: err.code, meta: err.meta });
      return NextResponse.json({ error: err.message, code: err.code, ...err.meta }, { status: 400 });
    }
    apiLogger.error({ err, msg: "credit-notes:failed", eventId, registrationId });
    return NextResponse.json({ error: "Failed to issue the credit note" }, { status: 500 });
  }
}
