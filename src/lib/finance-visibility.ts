/**
 * Finance visibility — who can see financial data (amounts, invoices, billing,
 * bank/tax, pricing).
 *
 * Decision record:
 *   - May 2026: only SUPER_ADMIN / ADMIN / ORGANIZER saw money; MEMBER was a
 *     read-only viewer with money hidden.
 *   - June 17, 2026 (organizer): MEMBER + ONSITE are registration-desk
 *     operators who **record payments**, so they now SEE money (amounts,
 *     prices, the Record Payment flow, quotes). They remain blocked from
 *     non-registration *writes* via `denyReviewer` — finance visibility and
 *     write permission are separate boundaries.
 *
 * This module is the single source of truth. UI conditional rendering,
 * API field-stripping, the agent redaction pass, and the denyFinance
 * guard all derive from `canViewFinance()` so the boundary can't drift.
 */

const FINANCE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE"]);

/** True when the role is permitted to see financial data. Fails closed —
 *  an unknown / missing role gets `false`. */
export function canViewFinance(role: string | null | undefined): boolean {
  return !!role && FINANCE_ROLES.has(role);
}

/**
 * Agent tools that are *wholly* financial — there's no non-finance payload
 * to salvage, so for non-finance roles they're refused outright rather
 * than redacted to an empty husk.
 */
export const FINANCE_ONLY_AGENT_TOOLS = new Set<string>([
  "list_invoices",
  "list_unpaid_registrations",
  // Analytics carries revenue (collected/outstanding) — finance-restricted
  // for the read-only MEMBER role on the in-app agent.
  "get_event_analytics",
]);

/**
 * Object keys that carry monetary / billing / tax / banking values. Used
 * by `redactFinancialFields` to deep-strip mixed payloads (e.g. a
 * registration list that also contains amounts). `paymentStatus` is
 * deliberately ABSENT — the status label is operational and kept.
 */
const FINANCIAL_KEYS = new Set<string>([
  // The whole computed money breakdown (subtotal/VAT/total/balance) —
  // strip it wholesale for MEMBER rather than relying on its inner keys.
  "financials",
  // CRM deal value (docs/CRM_MODULE_PLAN.md §9 decision 4). MEMBER reads the
  // sponsorship board but must not read the money on it — a sponsor-side
  // stakeholder holding a MEMBER account would otherwise see every rival
  // sponsor's deal value. Listed here so the existing redaction machinery
  // covers the CRM unchanged. The CRM's own predicate lives in
  // src/crm/lib/crm-visibility.ts (canViewDealValues) — deliberately NARROWER
  // than canViewFinance(), which includes MEMBER and ONSITE.
  //
  // ⚠ The column is `dealValue`, NOT `value`, specifically so it can appear in
  // this set. redactFinancialFields() is a RECURSIVE walk that strips a key by
  // NAME anywhere in the payload — and `value` is a generic key that already
  // occurs in unrelated shapes (survey free-text answers are
  // `{ responseId, submittedAt, value }`, see src/lib/survey/aggregate.ts).
  // Adding bare "value" here would silently blank every survey answer for
  // MEMBER. Any future financial field must be named specifically enough that
  // its key is unambiguous across the whole API surface.
  "dealValue",
  "amount",
  "amountPaid",
  "totalPaid",
  "totalRevenue",
  "revenue",
  "balanceDue",
  "price",
  "prices",
  "basePrice",
  "pricePerNight",
  "totalPrice",
  "unitPrice",
  "discountAmount",
  "discountValue",
  "originalPrice",
  "refundedAmount",
  "taxRate",
  "taxLabel",
  "taxAmount",
  "bankDetails",
  "taxNumber",
  "invoice",
  "invoices",
  "payment",
  "payments",
  "paymentReference",
  "paymentIntentId",
  "stripePaymentId",
  "cardBrand",
  "cardLast4",
  "receiptUrl",
  "billingAddress",
  "billingCity",
  "billingState",
  "billingZipCode",
  "billingCountry",
  "billingEmail",
  "billingPhone",
  "billingFirstName",
  "billingLastName",
  // "Charge to another account" — the third-party payer (with its
  // taxNumber + address), the PO/grant reference, and the guarantor flag
  // are billing/finance context. A MEMBER inferring "Dr. X is funded by
  // pharma Y" is exactly the Mecomed-sensitive disclosure MEMBER must not
  // see.
  "billingAccount",
  "billingAccountId",
  "payerReference",
  "attendeeIsGuarantor",
]);

/**
 * Deep-clone `value` with every financial key removed (recursively,
 * through arrays + nested objects). Non-destructive — returns a new
 * structure; the caller's original is untouched. Safe on primitives.
 *
 * Used by the agent result post-processor for MEMBER and any API path
 * that returns a mixed (operational + financial) payload to a MEMBER.
 */
export function redactFinancialFields<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactFinancialFields(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FINANCIAL_KEYS.has(k)) continue;
    out[k] = redactFinancialFields(v);
  }
  return out as T;
}
