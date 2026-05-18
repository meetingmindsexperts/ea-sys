/**
 * Finance visibility — the MEMBER role is an org-bound read-only viewer
 * that must NOT see financial data (amounts, invoices, billing, bank/tax,
 * pricing). Only SUPER_ADMIN / ADMIN / ORGANIZER see money.
 *
 * Decision record (organizer, May 2026):
 *   - Payment STATUS label (PAID / UNPAID / COMPLIMENTARY / INCLUSIVE) is
 *     OPERATIONAL, not financial — MEMBER keeps it (knowing who's actually
 *     coming is viewer-relevant). Amounts / invoices / billing / bank /
 *     tax / prices are financial — MEMBER never sees them.
 *   - One flat MEMBER role (no scoped finance-viewer variant).
 *
 * This module is the single source of truth. UI conditional rendering,
 * API field-stripping, the agent redaction pass, and the denyFinance
 * guard all derive from `canViewFinance()` so the boundary can't drift.
 */

const FINANCE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

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
]);

/**
 * Object keys that carry monetary / billing / tax / banking values. Used
 * by `redactFinancialFields` to deep-strip mixed payloads (e.g. a
 * registration list that also contains amounts). `paymentStatus` is
 * deliberately ABSENT — the status label is operational and kept.
 */
const FINANCIAL_KEYS = new Set<string>([
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
  "unitPrice",
  "discountAmount",
  "discountValue",
  "originalPrice",
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
