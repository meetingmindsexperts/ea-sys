/**
 * The purchase order's pure rules (spec §5, §6, §7.7): what a commitment is
 * called in each state, when an approved request may become one, and the
 * receiving rule from AED 50,000. No I/O, so the pages, the service and
 * the tests read one definition.
 */
import { Decimal, money, type MoneyInput } from "./money";

export type CommitmentStatusValue = "APPROVED" | "SENT_TO_ACCOUNTING" | "POSTED" | "CLOSED" | "CANCELLED";
export const COMMITMENT_STATUS_LABEL: Record<CommitmentStatusValue, string> = {
  APPROVED: "Issued",
  SENT_TO_ACCOUNTING: "Sent to accounting",
  POSTED: "Posted",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export type FulfillmentStatusValue = "OPEN" | "PARTIALLY_RECEIVED" | "RECEIVED";
export const FULFILLMENT_LABEL: Record<FulfillmentStatusValue, string> = {
  OPEN: "Not received",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
};

/**
 * Above this AED figure a full receipt needs a second person (spec §5, §6:
 * "above AED 50,000 (a setting) a second person confirms it"). A constant
 * until the settings home is decided (build plan §6, open owner question);
 * the comparison is on the request's stored AED figure, the one the
 * approval ceiling was judged on.
 */
export const RECEIPT_SECOND_PERSON_FLOOR_AED = new Decimal(50000);

/**
 * Does a full receipt of this order need a second person's confirmation?
 * An order with no AED figure (none exists today; a linked-external order
 * from Phase 4 could) fails CLOSED: it needs the confirmation.
 */
export function receiptNeedsSecondPerson(amountAed: MoneyInput | null | undefined): boolean {
  if (amountAed === null || amountAed === undefined) return true;
  return money(amountAed).gte(RECEIPT_SECOND_PERSON_FLOOR_AED);
}

export type OrderReadiness =
  | { ready: true }
  | { ready: false; reason: "status" | "supplier" | "already-ordered" };

/**
 * May this request become an order now? Approved (in either form) with an
 * approved, active supplier and no order yet. "Awaiting supplier" is the
 * approved form that waits for exactly the supplier condition.
 */
export function orderReadiness(r: { status: string; linkedCommitmentId: string | null; supplier: { approvalStatus: string; isActive: boolean } | null }): OrderReadiness {
  if (r.linkedCommitmentId) return { ready: false, reason: "already-ordered" };
  if (r.status !== "APPROVED" && r.status !== "AWAITING_SUPPLIER") return { ready: false, reason: "status" };
  if (!r.supplier || r.supplier.approvalStatus !== "APPROVED" || !r.supplier.isActive) return { ready: false, reason: "supplier" };
  return { ready: true };
}

/** The effective VAT percentage a stored pair implies, for the PDF's "VAT (5%)" line; null when no tax. */
export function impliedTaxRatePercent(amount: MoneyInput, taxAmount: MoneyInput): number | null {
  const a = money(amount);
  const t = money(taxAmount);
  if (a.lte(0) || t.lte(0)) return null;
  return Number(t.div(a).times(100).toDecimalPlaces(2).toString());
}
