import PDFDocument from "pdfkit";
import { apiLogger } from "./logger";
import {
  PAGE_MARGIN,
  drawHeader,
  drawInfoBoxes,
  drawLineItemsTable,
  drawTotals,
  drawNotesAndDisclaimer,
  drawBankDetails,
  drawPaymentReceived,
  drawFooters,
  ensureSpace,
  loadLocalLogo,
  formatDateShort,
} from "./pdf/document-layout";

export interface InvoicePDFData {
  // Document identity
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date | null;
  status: string;
  /** true when the issuing org has a TRN/tax ID — switches title to "TAX INVOICE" */
  isTaxInvoice: boolean;

  // Issuing organization (FROM)
  orgName: string;
  companyName: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  taxId: string | null;
  primaryColor: string | null;
  logoPath: string | null;

  // Bill-to (registrant)
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  jobTitle: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZipCode: string | null;
  billingCountry: string | null;
  taxNumber: string | null;

  // "Charge to another account" — when set, bill-to renders this payer and
  // the attendee drops to a reference line. null = self-pay (unchanged).
  payer?: {
    name: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zipCode?: string | null;
    country?: string | null;
    taxNumber?: string | null;
    reference?: string | null;
  } | null;

  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;

  // Line item
  registrationType: string;
  pricingTier: string | null;
  price: number;
  /** STORED figures from the invoice row (review M10). */
  taxAmount?: number | null;
  total?: number | null;
  currency: string;

  // Tax
  taxRate: number | null;
  taxLabel: string;

  // Discount
  discountCode: string | null;
  discountAmount: number;

  // Payment info
  bankDetails: string | null;
  supportEmail: string | null;

  // Settled-payment details, populated when status === "PAID" and the
  // linked Payment row has them. Rendered as a one-line Payment Received
  // block below the totals on paid invoices — e.g.
  //   "Paid on 24 Apr 2026 via Visa ending 4242 (Ref: pi_3Q...)"
  paymentMethodType?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  paidAt?: Date | null;
  paymentReference?: string | null;
}

const INVOICE_NOTES = [
  "Bookings and registrations cannot be confirmed until full receipt of payment or Purchase Order.",
  "All charges (including those of the beneficiary's bank) are to be paid by the sender.",
  "Please ensure you mention your invoice reference in your bank transfer. Once you have processed the bank transfer please provide us the SWIFT message copy for the same from the bank in order for us to be able to allocate the payment.",
];

export async function generateInvoicePDF(data: InvoicePDFData): Promise<Buffer> {
  const logoBuffer = await loadLocalLogo(data.logoPath);

  return new Promise((resolve, reject) => {
    try {
      // bufferPages: true so drawFooters can iterate via bufferedPageRange()
      // and stamp the correct "Page N/M" on every page after content is laid out.
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({
          err,
          msg: "invoice-pdf:stream-error",
          invoiceNumber: data.invoiceNumber,
          eventName: data.eventName,
        });
        reject(err);
      });

      const isPaid = data.status === "PAID";
      const documentTitle = data.isTaxInvoice ? "TAX INVOICE" : "INVOICE";

      // ── 1. Header ──
      const addressLines = [
        data.companyAddress,
        [data.companyCity, data.companyZipCode].filter(Boolean).join(" "),
        data.companyCountry,
      ].filter((line): line is string => !!line && line.trim().length > 0);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: data.companyName || data.orgName,
          addressLines,
          taxId: data.taxId,
        },
        centerTitle: data.eventName,
        documentTitle,
        logoBuffer,
      });

      // ── 2. Bill-to + meta boxes (4 meta rows for invoice) ──
      let nameLine: string;
      let secondLine: string | null;
      let locationLine: string | null;
      const meta = [
        { label: "Invoice Number", value: data.invoiceNumber },
        { label: "Issue Date", value: formatDateShort(data.issueDate) },
        {
          label: "Due Date",
          value: data.dueDate ? formatDateShort(data.dueDate) : "Upon receipt",
        },
        { label: "Status", value: data.status },
      ];

      if (data.payer) {
        // Third-party billing: bill-to = payer; attendee → reference line.
        nameLine = data.payer.name;
        secondLine = data.payer.contactName || null;
        const cityLine = [data.payer.city, data.payer.state, data.payer.zipCode]
          .filter(Boolean)
          .join(", ");
        locationLine =
          [data.payer.address, cityLine, data.payer.country].filter(Boolean).join(" ") || null;
        const attendeeName = [data.title, data.firstName, data.lastName]
          .filter(Boolean)
          .join(" ");
        meta.push({ label: "Attendee", value: attendeeName });
        if (data.payer.reference)
          meta.push({ label: "PO / Reference", value: data.payer.reference });
        if (data.payer.taxNumber)
          meta.push({ label: "Tax No", value: data.payer.taxNumber });
      } else {
        const namePart = [data.title, data.firstName].filter(Boolean).join(" ");
        nameLine = namePart ? `${data.lastName}, ${namePart}` : data.lastName;
        secondLine = data.jobTitle || data.organization;
        const cityLine = [data.billingCity, data.billingState, data.billingZipCode]
          .filter(Boolean)
          .join(", ");
        locationLine =
          [cityLine, data.billingCountry].filter(Boolean).join(" ") || null;
        // Tax No (registrant TRN) lives inside the right-hand info box.
        if (data.taxNumber) meta.push({ label: "Tax No", value: data.taxNumber });
      }

      y = ensureSpace(doc, y, 90);
      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine,
          secondLine,
          locationLine,
        },
        meta,
      });

      // ── 3. Line items ──
      const itemDescription = data.pricingTier
        ? `${data.registrationType} - ${data.pricingTier}`
        : data.registrationType;

      y = ensureSpace(doc, y, 80);
      y = drawLineItemsTable(doc, y, data.currency, [
        {
          name: "Registration",
          items: [{ description: itemDescription, amount: data.price }],
        },
      ]);

      // ── 4. Totals — always Subtotal + (Discount) + VAT + Total ──
      y = ensureSpace(doc, y, 100);
      y = drawTotals(doc, y, {
        currency: data.currency,
        subtotal: data.price,
        discountAmount: data.discountAmount || 0,
        discountLabel: data.discountCode
          ? `Discount (${data.discountCode})`
          : data.discountAmount
          ? "Discount"
          : null,
        taxRate: data.taxRate,
        taxLabel: data.taxLabel,
        totalLabel: isPaid ? "TOTAL PAID" : "TOTAL OUTSTANDING",
        taxAmountOverride: data.taxAmount ?? null,
        grandTotalOverride: data.total ?? null,
      });

      // ── 5. Notes + VAT disclaimer ──
      const showVatDisclaimer = !!data.taxRate && data.taxRate > 0;
      y = ensureSpace(doc, y, 120);
      y = drawNotesAndDisclaimer(doc, y, INVOICE_NOTES, showVatDisclaimer);

      // ── 6a. Payment received (only when paid) ──
      if (isPaid && (data.paidAt || data.cardLast4 || data.paymentMethodType)) {
        y = ensureSpace(doc, y, 60);
        y = drawPaymentReceived(doc, y, {
          paymentMethodType: data.paymentMethodType,
          cardBrand: data.cardBrand,
          cardLast4: data.cardLast4,
          paidAt: data.paidAt,
          reference: data.paymentReference,
        });
      }

      // ── 6b. Bank details (only when unpaid — nothing to transfer to once settled) ──
      if (data.bankDetails && !isPaid) {
        y = ensureSpace(doc, y, 90);
        drawBankDetails(doc, y, data.bankDetails);
      }

      // ── PAID watermark (preserved from previous design) ──
      if (isPaid) {
        doc.save();
        doc.rotate(-45, {
          origin: [doc.page.width / 2, doc.page.height / 2],
        });
        doc
          .fontSize(80)
          .fillColor("#22c55e")
          .fillOpacity(0.12)
          .font("Helvetica-Bold")
          .text("PAID", doc.page.width / 2 - 120, doc.page.height / 2 - 40);
        doc.restore();
        doc.fillOpacity(1);
      }

      // ── 7. Footers — written after content so Page N/M reflects real layout ──
      drawFooters(doc, data.issueDate);

      doc.end();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "invoice-pdf:render-failed",
        invoiceNumber: data.invoiceNumber,
        eventName: data.eventName,
      });
      reject(err);
    }
  });
}
