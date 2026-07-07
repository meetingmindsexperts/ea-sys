import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { issuePaidRegistrationDocuments } from "@/lib/invoice-service";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

/**
 * POST /api/events/[eventId]/registrations/[registrationId]/documents/resend
 *
 * Re-send the combined post-payment packet (the PAID invoice PDF + the receipt
 * PDF, in ONE email) for a single registration — the same packet the payment
 * flow sends automatically. Idempotent: reuses the existing invoice + receipt
 * rows, or creates whichever is missing (so it also heals a legacy/partially-
 * issued registration) before emailing. Finance-gated (denyReviewer blocks
 * REVIEWER/SUBMITTER/REGISTRANT/MEMBER/ONSITE), org-scoped.
 */
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({ key: `resend-documents:${session.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "registration-documents:rate-limited", userId: session.user.id, registrationId });
      return NextResponse.json(
        { error: "Too many resends. Try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: 30, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: { id: registrationId, eventId },
      select: {
        id: true,
        payments: {
          where: { status: "PAID" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true, amount: true, currency: true, receiptUrl: true,
            paymentMethodType: true, stripePaymentId: true, paidAt: true,
          },
        },
      },
    });
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const payment = registration.payments[0];
    if (!payment) {
      return NextResponse.json(
        { error: "No completed payment for this registration — nothing to receipt yet.", code: "NO_PAID_PAYMENT" },
        { status: 400 },
      );
    }

    const { invoice, receipt } = await issuePaidRegistrationDocuments({
      registrationId,
      eventId,
      organizationId: event.organizationId,
      paymentId: payment.id,
      paymentMethod: payment.paymentMethodType || "card",
      paymentReference: payment.stripePaymentId || undefined,
      paidAt: payment.paidAt ?? undefined,
      amount: Number(payment.amount),
      currency: payment.currency,
      receiptUrl: payment.receiptUrl,
    });

    apiLogger.info({
      msg: "registration-documents:resent",
      registrationId, eventId,
      invoiceId: invoice.id, receiptId: receipt.id,
      userId: session.user.id,
    });

    return NextResponse.json({
      success: true,
      message: `Invoice ${invoice.invoiceNumber} + receipt ${receipt.invoiceNumber} emailed.`,
      invoiceNumber: invoice.invoiceNumber,
      receiptNumber: receipt.invoiceNumber,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resending registration documents" });
    return NextResponse.json({ error: "Failed to resend documents" }, { status: 500 });
  }
}
