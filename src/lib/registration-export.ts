/**
 * Registrations CSV export — the single source of truth for the column set
 * and the per-row values.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The registrations CSV used to be built entirely in the browser: it read the
 * already-fetched React Query rows, produced a Blob, and triggered a download.
 * No request ever reached the server, so the largest routine export of attendee
 * PII in the product left **no trace of any kind** — not in `AuditLog`, not in
 * `/logs`. "Who exported the attendee list?" was unanswerable.
 *
 * The export now runs server-side (`GET …/registrations?export=csv`) so it can
 * be audited. The row logic lives here rather than inline in the route so the
 * shape is stated once and can be unit-tested without standing up a request.
 *
 * REDACTION CONTRACT
 * ------------------
 * The route applies `redactFinancialFields` / `redactBarcodeFields` to the
 * payload **before** calling in here. This module therefore treats every
 * redactable field as optional and renders "" when it is absent — a MEMBER's
 * CSV simply has empty money/barcode columns rather than a different shape.
 * That is deliberate: a stable column set means a spreadsheet template built
 * against one role's export still parses another's.
 *
 * The column set matches what the on-screen table exports, so the move
 * server-side is not a behaviour change for the operator.
 */

import { NO_PAYMENT_DUE_STATUSES } from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";
import { displayRegistrationType } from "@/lib/faculty-filter";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { formatSerialId } from "@/lib/registration-serial";
import { formatAttendeeRole } from "@/lib/schemas";
import { formatDate } from "@/lib/utils";

/** Column headers, in order. Exported so tests can assert row/header parity. */
export const REGISTRATION_EXPORT_HEADERS = [
  "Registration ID",
  "Serial ID",
  "Title",
  "Role",
  "First Name",
  "Last Name",
  "Email",
  "Organization",
  "Job Title",
  "Phone",
  "City",
  "Country",
  "Bio",
  "Specialty",
  "Tags",
  "Registration Type",
  "Pricing Tier",
  "Payer",
  "Status",
  "Payment Status",
  "Amount Due",
  "Total Paid",
  "Discount",
  "Promo Code",
  "DTCM Barcode",
  "Registered Date",
  "Checked In Date",
  "Source",
  "Medium",
  "Campaign",
  "Referrer",
] as const;

/**
 * Structural shape of a row as the list GET produces it. Every field the
 * redaction layers can strip is optional — see the redaction contract above.
 */
export interface RegistrationExportRow {
  id: string;
  serialId?: number | null;
  status: string;
  paymentStatus: string;
  createdAt: Date | string;
  checkedInAt?: Date | string | null;
  dtcmBarcode?: string | null;
  discountAmount?: unknown;
  originalPrice?: unknown;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  attendee: {
    title?: string | null;
    role?: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
    city?: string | null;
    country?: string | null;
    bio?: string | null;
    specialty?: string | null;
    tags?: string[] | null;
    registrationType?: string | null;
  };
  ticketType?: { id?: string; name?: string | null; isFaculty?: boolean | null; currency?: string | null; price?: unknown } | null;
  pricingTier?: { name?: string | null; currency?: string | null; price?: unknown } | null;
  billingAccount?: { name?: string | null } | null;
  promoCode?: { code?: string | null } | null;
  payments?: Array<{ status?: string | null; amount: unknown }> | null;
}

export interface RegistrationExportContext {
  /** Event tax rate as a number, or null when the event charges no tax. */
  taxRate: number | null;
  taxLabel: string | null;
}

/** Money columns render "" (not "0.00") when redaction removed the inputs. */
function money(n: number | null): string {
  return n === null ? "" : n.toFixed(2);
}

/**
 * Build one CSV row (unescaped cell values — the caller applies `toCsvRow`).
 *
 * Financials use the same `computeRegistrationFinancials` helper the detail
 * sheet and the quote/invoice PDFs use, so the CSV cannot disagree with them
 * on VAT.
 */
export function buildRegistrationExportRow(
  r: RegistrationExportRow,
  ctx: RegistrationExportContext,
): string[] {
  // `payments` is a financial field — absent for non-finance roles. Distinguish
  // "redacted" (null → blank cell) from "genuinely nothing paid" (0.00).
  const financeVisible = r.payments !== undefined;

  const totalPaid = financeVisible
    ? (r.payments ?? [])
        .filter((p) => p.status === "PAID" || String(p.status).toLowerCase() === "succeeded")
        .reduce((sum, p) => sum + Number(p.amount), 0)
    : null;

  let amountDue: number | null = null;
  let discount: number | null = null;
  if (financeVisible) {
    const fin = computeRegistrationFinancials({
      subtotal: readRegistrationBasePrice(r),
      discount: r.discountAmount != null ? Number(r.discountAmount) : 0,
      taxRate: ctx.taxRate,
      taxLabel: ctx.taxLabel,
      currency: r.pricingTier?.currency ?? r.ticketType?.currency ?? undefined,
      totalPaid: totalPaid ?? 0,
    });
    discount = fin.discount;
    // A CANCELLED registration owes nothing (organizer decision — matches the
    // detail-sheet display + the server-side financials override); a settled
    // status (PAID/COMPLIMENTARY/INCLUSIVE/REFUNDED) owes nothing either.
    const noPaymentDue =
      r.status === "CANCELLED" ||
      (NO_PAYMENT_DUE_STATUSES as readonly string[]).includes(r.paymentStatus);
    amountDue = noPaymentDue ? 0 : fin.balanceDue;
  }

  return [
    r.id,
    formatSerialId(r.serialId),
    r.attendee.title || "",
    formatAttendeeRole(r.attendee.role, ""),
    r.attendee.firstName,
    r.attendee.lastName,
    r.attendee.email,
    r.attendee.organization || "",
    r.attendee.jobTitle || "",
    r.attendee.phone || "",
    r.attendee.city || "",
    r.attendee.country || "",
    r.attendee.bio || "",
    r.attendee.specialty || "",
    (r.attendee.tags ?? []).join(", "),
    displayRegistrationType(
      {
        ticketTypeName: r.ticketType?.name ?? undefined,
        isFaculty: r.ticketType?.isFaculty ?? undefined,
        attendeeRegistrationType: r.attendee.registrationType ?? undefined,
      },
      "",
    ),
    r.pricingTier?.name ?? "",
    // Third-party payer; blank = attendee self-pays. In FINANCIAL_KEYS, so the
    // field is simply absent from a non-finance caller's payload.
    r.billingAccount?.name ?? "",
    r.status,
    r.paymentStatus,
    money(amountDue),
    money(totalPaid),
    money(discount),
    r.promoCode?.code ?? "",
    // Physical-access credential — stripped by redactBarcodeFields for anyone
    // who doesn't run the door (MEMBER included).
    r.dtcmBarcode || "",
    formatDate(r.createdAt),
    r.checkedInAt ? formatDate(r.checkedInAt) : "",
    r.utmSource || "",
    r.utmMedium || "",
    r.utmCampaign || "",
    r.referrer || "",
  ];
}
