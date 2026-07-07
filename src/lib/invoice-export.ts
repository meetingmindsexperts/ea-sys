/**
 * Shared invoice-export formatters — used by BOTH the org-level
 * (`/api/invoices/export`) and per-event (`/api/events/[id]/invoices/export`)
 * routes so the CSV + QuickBooks output is byte-identical everywhere.
 *
 * Pure: takes already-fetched rows (shaped by INVOICE_EXPORT_SELECT), returns
 * a CSV string. No Prisma / I/O here — the routes own the query + HTTP layer.
 */
import { Prisma } from "@prisma/client";

/**
 * The Prisma `select` both export routes use, so the two fetch the exact same
 * columns the formatters read.
 */
export const INVOICE_EXPORT_SELECT = {
  invoiceNumber: true,
  type: true,
  status: true,
  issueDate: true,
  dueDate: true,
  paidDate: true,
  subtotal: true,
  discountAmount: true,
  taxRate: true,
  taxAmount: true,
  total: true,
  currency: true,
  event: { select: { name: true, city: true } },
  registration: {
    select: {
      billingAddress: true,
      ticketType: { select: { name: true } },
      pricingTier: { select: { name: true } },
      attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
    },
  },
} satisfies Prisma.InvoiceSelect;

/** Row shape produced by INVOICE_EXPORT_SELECT (loosely typed on the Decimals). */
export interface InvoiceExportRow {
  invoiceNumber: string;
  type: string;
  status: string;
  issueDate: Date;
  dueDate: Date | null;
  paidDate: Date | null;
  subtotal: Prisma.Decimal | number;
  discountAmount: Prisma.Decimal | number;
  taxRate: Prisma.Decimal | number | null;
  taxAmount: Prisma.Decimal | number;
  total: Prisma.Decimal | number;
  currency: string;
  event: { name: string; city: string | null };
  registration: {
    billingAddress: string | null;
    ticketType: { name: string } | null;
    pricingTier: { name: string } | null;
    attendee: { title: string | null; firstName: string; lastName: string; email: string };
  };
}

// ── CSV primitives ───────────────────────────────────────────────────────────
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Formula-injection guard: Excel / QuickBooks / Google Sheets treat a cell
  // that begins with = + - @ (or a leading tab / carriage-return) as a FORMULA.
  // Names, organization, and billing address flow into these exports and are
  // attacker-controllable via public self-registration, so prefix a single
  // quote to force the value to render as literal text. (OWASP CSV injection.)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function ymd(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}
// QuickBooks wants DD-MMM-YY, e.g. 29-Jan-25.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function qbDate(d: Date | null): string {
  if (!d) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`;
}

// ── Plain reconciliation CSV ─────────────────────────────────────────────────
export function buildInvoiceCsv(invoices: InvoiceExportRow[]): string {
  const header = [
    "Invoice #", "Type", "Status", "Event", "Bill-to", "Email",
    "Issue date", "Due date", "Paid date", "Subtotal", "Discount", "Tax", "Total", "Currency",
  ];
  const rows = invoices.map((inv) => [
    inv.invoiceNumber, inv.type, inv.status, inv.event.name,
    `${inv.registration.attendee.firstName} ${inv.registration.attendee.lastName}`.trim(),
    inv.registration.attendee.email,
    ymd(inv.issueDate), ymd(inv.dueDate), ymd(inv.paidDate),
    Number(inv.subtotal).toFixed(2), Number(inv.discountAmount).toFixed(2),
    Number(inv.taxAmount).toFixed(2), Number(inv.total).toFixed(2), inv.currency,
  ]);
  return toCsv([header, ...rows]);
}

// ── QuickBooks invoice-import CSV ─────────────────────────────────────────────
// We fill every column from what we store; a few are QuickBooks-side conventions
// we can only default (adjust the constants to match your QB setup):
//   • SalesTerm   — we don't store payment terms → "Due on receipt"
//   • LineItem    — left BLANK (map from your QB item list on import)
//   • LineClass   — the event name (no prefix)
//   • LineTaxCode — "Standard" when VAT applies, else "Zero Rated"
//   • Customer    — the attendee's Title First Last (may need to match your QB list)
// LineUnitPrice is the net-of-discount (post-discount, pre-tax) price; LineAmount
// is the gross total; AmountsIncl=TaxExcluded — so unitPrice×qty + tax = LineAmount
// reconciles even with a discount, matching the reference template (100 → 105 at 5%).
export function buildInvoiceQuickBooksCsv(invoices: InvoiceExportRow[]): string {
  const header = [
    "RefNumber", "TxnDate", "Customer", "BillAddrLine1", "SalesTerm", "Location",
    "LineClass", "LineUnitPrice", "AmountsIncl", "LineDesc", "LineItem", "LineQty",
    "LineAmount", "LineTaxCode", "Currency",
  ];
  const rows = invoices.map((inv) => {
    const att = inv.registration.attendee;
    const customer = `${att.title ? att.title + " " : ""}${att.firstName} ${att.lastName}`.trim();
    const taxed = inv.taxRate != null && Number(inv.taxRate) > 0;
    return [
      inv.invoiceNumber,                                   // RefNumber
      qbDate(inv.issueDate),                               // TxnDate
      customer,                                            // Customer
      inv.registration.billingAddress ?? "",              // BillAddrLine1
      "Due on receipt",                                    // SalesTerm
      inv.event.city ?? "",                                // Location
      inv.event.name,                                      // LineClass (no prefix)
      // LineUnitPrice = NET (post-discount, pre-tax) price so QB reconciles:
      // unitPrice × qty + tax = LineAmount (= total). The discount is baked in
      // here (the flat qty-1 template has no separate discount line); it's still
      // a distinct column in the plain reconciliation CSV.
      Math.max(0, Number(inv.subtotal) - Number(inv.discountAmount)).toFixed(2), // LineUnitPrice (net of discount)
      "TaxExcluded",                                       // AmountsIncl
      [inv.registration.ticketType?.name, inv.registration.pricingTier?.name]
        .filter(Boolean).join(" - ") || inv.type,          // LineDesc (ticket type + pricing tier)
      "",                                                  // LineItem (blank — set from your QB item list)
      1,                                                   // LineQty
      Number(inv.total).toFixed(2),                        // LineAmount (gross)
      taxed ? "Standard" : "Zero Rated",                   // LineTaxCode
      inv.currency,                                        // Currency
    ];
  });
  return toCsv([header, ...rows]);
}
