/**
 * invoice-reconciliation job — recovers post-payment invoices the Stripe
 * webhook failed to create (audit Round 2, DATA-5).
 *
 * Cadence: every 10 minutes. The sweep finds PAID registrations that have a
 * PAID Payment but no INVOICE-type Invoice and re-runs the same
 * createPaidInvoice + sendInvoiceEmail path the webhook uses. Idempotent and
 * bounded (25/tick); a no-op when the candidate set is empty.
 */

import { runInvoiceReconciliationTick } from "@/lib/invoice-reconciliation-worker";
import { resolveStaleRefundAttempts } from "@/lib/refund-reconciliation";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "invoice-reconciliation";
export const JOB_ID = JOB_IDS.INVOICE_RECONCILIATION;
export const SCHEDULE = "*/10 * * * *"; // every 10 minutes

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runInvoiceReconciliationTick();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: JOB_NAME,
      });
    }
    // Refund-attempt sweep (review H4/H5, July 10 2026) rides the same
    // money-reconciliation cadence: settles PENDING/UNKNOWN RefundAttempt rows
    // older than 10 min against Stripe's ground truth. Isolated try/catch so
    // an invoice-sweep failure can't starve it and vice versa.
    try {
      await resolveStaleRefundAttempts();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "worker:tick-uncaught",
        job: `${JOB_NAME}:refund-attempts`,
      });
    }
  });
}
