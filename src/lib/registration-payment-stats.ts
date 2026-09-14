/**
 * The registrations page's "Paid" card (Sep 14, 2026, organiser report on
 * OOPVF2026). The card used to count PAID plus COMPLIMENTARY as one number,
 * so a free forum with 123 complimentary delegates read "Paid 123" as if
 * money had come in. Paid now means money collected; the free and the
 * sponsor-paid registrations are shown beside it, never inside it.
 *
 * Pure and client-safe: the page already holds the rows, so this costs no
 * request and no query.
 */

export interface PaymentStatusSummary {
  /** Money collected from the attendee (or their payer). */
  paid: number;
  /** No charge by the organiser's decision. */
  complimentary: number;
  /** A sponsor settled it offline; the attendee owes nothing. */
  inclusive: number;
}

export function summarizePaymentStatuses(
  rows: ReadonlyArray<{ paymentStatus: string }>,
): PaymentStatusSummary {
  const summary: PaymentStatusSummary = { paid: 0, complimentary: 0, inclusive: 0 };
  for (const row of rows) {
    if (row.paymentStatus === "PAID") summary.paid += 1;
    else if (row.paymentStatus === "COMPLIMENTARY") summary.complimentary += 1;
    else if (row.paymentStatus === "INCLUSIVE") summary.inclusive += 1;
  }
  return summary;
}

/**
 * The line under the number: "123 complimentary", "12 complimentary · 3
 * sponsor-paid", or null when neither applies so the card stays as it was
 * on a paid event.
 */
export function paidCardNote(summary: PaymentStatusSummary): string | null {
  const parts: string[] = [];
  if (summary.complimentary > 0) parts.push(`${summary.complimentary} complimentary`);
  if (summary.inclusive > 0) parts.push(`${summary.inclusive} sponsor-paid`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
