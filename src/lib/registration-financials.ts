/**
 * Single source of truth for a registration's money breakdown —
 * subtotal, discount, VAT, total, paid, balance due.
 *
 * Pure: no Prisma, no I/O, no Date coercion. Callers resolve the raw
 * numbers from the registration/event/payments and pass primitives.
 * Both the detail-sheet "Payment Pending" block and the Payment Summary
 * render from this so the two surfaces can never diverge, and it mirrors
 * the quote/invoice PDF math (`drawTotals`): tax applies to
 * (subtotal − discount), total = taxableBase + tax.
 *
 * Finance-gated: the detail GET attaches the result as `financials`,
 * which `redactFinancialFields()` strips wholesale for the MEMBER
 * read-only role (see finance-visibility.ts — `financials` is a
 * FINANCIAL_KEY).
 */

export interface RegistrationFinancialsInput {
  /** Tier price if a pricing tier applies, else the ticket-type price. 0 for free/no-ticket. */
  subtotal: number;
  /** Promo/manual discount applied to the subtotal. 0 when none. */
  discount?: number;
  /** Event tax rate as a percentage (e.g. 5 for 5%). null/0 → no tax line. */
  taxRate?: number | null;
  /** Display label for the tax line. Defaults to "VAT". */
  taxLabel?: string | null;
  /** ISO currency code for display. Defaults to "USD". */
  currency?: string | null;
  /** Sum of settled payments (Stripe + manually-captured bank/cash/card). */
  totalPaid?: number;
}

export interface RegistrationFinancials {
  currency: string;
  subtotal: number;
  discount: number;
  /** subtotal − discount (never negative); the base VAT is computed on. */
  taxableBase: number;
  taxRate: number;
  taxLabel: string;
  taxAmount: number;
  /** taxableBase + taxAmount. */
  total: number;
  totalPaid: number;
  /** total − totalPaid, floored at 0. */
  balanceDue: number;
  /** true when nothing is owed (balance ≤ 1 cent — float guard). */
  isPaidInFull: boolean;
  /** true when there's a positive amount still owed. */
  hasOutstandingBalance: boolean;
}

/** Round to 2 dp without binary-float drift (e.g. 1.005 → 1.01). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeRegistrationFinancials(
  input: RegistrationFinancialsInput,
): RegistrationFinancials {
  const subtotal = Math.max(0, Number(input.subtotal) || 0);
  const discount = Math.max(0, Number(input.discount) || 0);
  const taxRate = Math.max(0, Number(input.taxRate) || 0);
  const taxLabel = input.taxLabel || "VAT";
  const currency = input.currency || "USD";
  const totalPaid = Math.max(0, Number(input.totalPaid) || 0);

  // Discount can't exceed the subtotal — a misconfigured promo shouldn't
  // produce a negative taxable base.
  const taxableBase = round2(Math.max(0, subtotal - discount));
  const taxAmount = round2(taxableBase * (taxRate / 100));
  const total = round2(taxableBase + taxAmount);
  const balanceDue = round2(Math.max(0, total - totalPaid));
  // 1-cent tolerance: a fully-paid registration can land at e.g. 0.004
  // after rounding across partial bank-transfer captures.
  const isPaidInFull = balanceDue <= 0.01;

  return {
    currency,
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxableBase,
    taxRate,
    taxLabel,
    taxAmount,
    total,
    totalPaid: round2(totalPaid),
    balanceDue,
    isPaidInFull,
    hasOutstandingBalance: !isPaidInFull && total > 0,
  };
}
