/**
 * Invoice reconciliation worker — recovers post-payment invoices that the
 * Stripe webhook failed to create.
 *
 * Why this exists (audit Round 2, DATA-5): the Stripe `checkout.session.completed`
 * webhook commits the `Payment` row + flips the registration to PAID in its main
 * transaction, but creates the system Invoice (+ emails it) in a **detached
 * post-commit block**. If that block throws (Supabase pooler blip, SES throttle),
 * the registration is durably PAID yet has no invoice, and nothing re-attempts —
 * the webhook can't retry a post-commit failure. This sweep closes that gap.
 *
 * The reconciliation signature is precise: a registration that is PAID, has a
 * PAID `Payment` row (so money really moved), but has no `INVOICE`-type Invoice.
 * Each recovery reuses the same `createPaidInvoice` + `sendInvoiceEmail` path as
 * the webhook, so the output is identical to a successful webhook. Idempotent —
 * once an invoice exists the registration drops out of the candidate set.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { createPaidInvoice, sendInvoiceEmail } from "@/lib/invoice-service";

// Bounded look-back so the scan stays cheap. A dropped invoice is reconciled
// within one cron cadence of the payment, far inside this window; older gaps
// (pre-window) are rare and can be handled manually.
export const RECONCILE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// Cap work per tick so one sweep can't monopolize a worker / connection.
export const RECONCILE_BATCH = 25;

export interface InvoiceReconciliationReport {
  scanned: number;
  reconciled: number;
  failed: number;
  durationMs: number;
}

/**
 * One reconciliation tick. Pure async function — no HTTP, no auth. Invoked by
 * the node-cron worker (worker/jobs/invoice-reconciliation.ts) under an
 * advisory lock. Per-row failures are isolated so one bad registration can't
 * stop the batch.
 */
export async function runInvoiceReconciliationTick(): Promise<InvoiceReconciliationReport> {
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - RECONCILE_LOOKBACK_MS);

  const candidates = await db.registration.findMany({
    where: {
      paymentStatus: "PAID",
      updatedAt: { gte: cutoff },
      // No system invoice yet …
      invoices: { none: { type: "INVOICE" } },
      // … but a real PAID payment exists → the webhook's invoice block dropped.
      payments: { some: { status: "PAID" } },
    },
    select: {
      id: true,
      eventId: true,
      event: { select: { organizationId: true } },
      payments: {
        where: { status: "PAID" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          stripePaymentId: true,
          paymentMethodType: true,
          paidAt: true,
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: RECONCILE_BATCH,
  });

  let reconciled = 0;
  let failed = 0;

  for (const reg of candidates) {
    const payment = reg.payments[0];
    if (!payment) continue; // defensive — the `where` guarantees one

    try {
      const invoice = await createPaidInvoice({
        registrationId: reg.id,
        eventId: reg.eventId,
        organizationId: reg.event.organizationId,
        paymentId: payment.id,
        paymentMethod: payment.paymentMethodType || "card",
        paymentReference: payment.stripePaymentId || undefined,
        paidAt: payment.paidAt ?? undefined,
      });
      await sendInvoiceEmail(invoice.id);
      reconciled++;
      apiLogger.info({
        msg: "invoice-reconciliation:recovered",
        registrationId: reg.id,
        eventId: reg.eventId,
        invoiceId: invoice.id,
      });
    } catch (err) {
      failed++;
      apiLogger.error({
        err,
        msg: "invoice-reconciliation:recover-failed",
        registrationId: reg.id,
        eventId: reg.eventId,
      });
      // Continue — one bad row must not abort the rest of the batch.
    }
  }

  const report: InvoiceReconciliationReport = {
    scanned: candidates.length,
    reconciled,
    failed,
    durationMs: Date.now() - startedAt,
  };
  // Only emit a tick summary when there was something to do (avoid log noise
  // every 10 min on a healthy system where the candidate set is empty).
  if (candidates.length > 0) {
    apiLogger.info({ msg: "invoice-reconciliation:tick", ...report });
  }
  return report;
}
