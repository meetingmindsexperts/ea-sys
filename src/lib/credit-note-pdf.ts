import PDFDocument from "pdfkit";
import { apiLogger } from "./logger";
import {
  PAGE_MARGIN,
  drawHeader,
  drawInfoBoxes,
  drawLineItemsTable,
  drawTotals,
  drawFooters,
  ensureSpace,
  loadLocalLogo,
  formatDateShort,
} from "./pdf/document-layout";

export interface CreditNotePDFData {
  // Document identity
  creditNoteNumber: string;
  issueDate: Date;
  originalInvoiceNumber: string | null;
  // From (organization)
  orgName: string;
  companyName: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  taxId: string | null;
  primaryColor: string | null;
  logoPath: string | null;
  // Issued To
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;
  // Line items
  registrationType: string;
  pricingTier: string | null;
  price: number;
  /** STORED, reconciled figures from the credit-note row (review M10). */
  taxAmount?: number | null;
  total?: number | null;
  currency: string;
  taxRate: number | null;
  taxLabel: string;
  discountCode: string | null;
  discountAmount: number;
  // Reason
  notes: string | null;
}

/**
 * Credit-note PDF. Shares the invoice/quote branded layout
 * (`@/lib/pdf/document-layout`) — logo + 3-column header + info boxes + line
 * items + totals + footers — so it's visually consistent with the invoice, just
 * titled "CREDIT NOTE" with a "TOTAL CREDIT" line. Amounts render positive
 * (standard credit-note convention — the document type conveys the credit).
 */
export async function generateCreditNotePDF(data: CreditNotePDFData): Promise<Buffer> {
  const logoBuffer = await loadLocalLogo(data.logoPath);

  return new Promise((resolve, reject) => {
    try {
      // bufferPages: true so drawFooters can stamp "Page N/M" after layout.
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({ err, msg: "credit-note-pdf:stream-error", creditNoteNumber: data.creditNoteNumber });
        reject(err);
      });

      // ── 1. Header (logo + company block + CREDIT NOTE title) ──
      const addressLines = [
        data.companyAddress,
        [data.companyCity, data.companyState, data.companyZipCode].filter(Boolean).join(" "),
        data.companyCountry,
      ].filter((line): line is string => !!line && line.trim().length > 0);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: data.companyName || data.orgName,
          addressLines,
          taxId: data.taxId,
        },
        centerTitle: data.eventName,
        documentTitle: "CREDIT NOTE",
        logoBuffer,
      });

      // ── 2. Issued-to + meta boxes ──
      const namePart = [data.title, data.firstName].filter(Boolean).join(" ");
      const nameLine = namePart ? `${data.lastName}, ${namePart}` : data.lastName;
      const meta = [
        { label: "Credit Note", value: data.creditNoteNumber },
        { label: "Issue Date", value: formatDateShort(data.issueDate) },
      ];
      if (data.originalInvoiceNumber) {
        meta.push({ label: "Ref Invoice", value: data.originalInvoiceNumber });
      }

      y = ensureSpace(doc, y, 90);
      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine,
          secondLine: data.organization,
          addressLine: null,
          locationLine: null,
        },
        meta,
      });

      // ── 3. Line items (Refund) ──
      const itemDescription = data.pricingTier
        ? `${data.registrationType} - ${data.pricingTier}`
        : data.registrationType;

      y = ensureSpace(doc, y, 80);
      y = drawLineItemsTable(doc, y, data.currency, [
        {
          name: "Registration (Refund)",
          items: [{ description: itemDescription, amount: data.price }],
        },
      ]);

      // ── 4. Totals — "TOTAL CREDIT" ──
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
        totalLabel: "TOTAL CREDIT",
        taxAmountOverride: data.taxAmount ?? null,
        grandTotalOverride: data.total ?? null,
      });

      // ── 5. Reason ──
      if (data.notes) {
        y = ensureSpace(doc, y, 60);
        const pageWidth = doc.page.width - PAGE_MARGIN * 2;
        doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("REASON", PAGE_MARGIN, y);
        y += 14;
        doc.fontSize(9).fillColor("#475569").font("Helvetica").text(data.notes, PAGE_MARGIN, y, { width: pageWidth });
      }

      // ── 6. Footers (written after content so Page N/M is correct) ──
      drawFooters(doc, data.issueDate);

      doc.end();
    } catch (err) {
      apiLogger.error({ err, msg: "credit-note-pdf:render-failed", creditNoteNumber: data.creditNoteNumber });
      reject(err);
    }
  });
}
