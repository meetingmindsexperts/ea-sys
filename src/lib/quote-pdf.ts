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
  drawFooters,
  ensureSpace,
  loadLocalLogo,
  formatDateShort,
} from "./pdf/document-layout";

interface QuoteData {
  // Document identity
  quoteNumber: string;
  date: Date;
  validUntil?: Date;

  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;

  // Registrant (bill-to)
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  jobTitle: string | null;
  billingCity: string | null;
  billingCountry: string | null;

  // Line item
  registrationType: string;
  pricingTier: string | null;
  price: number;
  currency: string;

  // Tax
  taxRate: number | null;
  taxLabel: string;

  // Payment info
  bankDetails: string | null;
  supportEmail: string | null;

  // Issuing organization
  organizationName: string;
  companyName: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  taxId: string | null;
  logoPath: string | null;
}

const QUOTE_NOTES = [
  "For immediate payment.",
  "Bookings and registrations cannot be confirmed until full receipt of payment or Purchase Order.",
  "All charges (including those of the beneficiary's bank) are to be paid by the sender.",
  "Please ensure you mention your quote reference in your bank transfer. Once you have processed the bank transfer please provide us the SWIFT message copy for the same from the bank in order for us to be able to allocate the payment.",
];

/**
 * Generates a registration quote/proforma invoice as a PDF buffer matching
 * the Meeting Minds reference layout.
 */
export async function generateQuotePDF(data: QuoteData): Promise<Buffer> {
  // Logo is loaded before opening the doc — fs is async, can't be done inline.
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
          msg: "quote-pdf:stream-error",
          quoteNumber: data.quoteNumber,
          eventName: data.eventName,
        });
        reject(err);
      });

      // ── 1. Header (3 columns: company / centered title / logo) ──
      const addressLines = [
        data.companyAddress,
        [data.companyCity, data.companyZipCode].filter(Boolean).join(" "),
        data.companyCountry,
      ].filter((line): line is string => !!line && line.trim().length > 0);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: data.companyName || data.organizationName,
          addressLines,
          taxId: data.taxId,
        },
        centerTitle: data.eventName,
        documentTitle: "QUOTE",
        logoBuffer,
      });

      // ── 2. Bill-to + meta boxes ──
      const namePart = [data.title, data.firstName].filter(Boolean).join(" ");
      const nameLine = namePart ? `${data.lastName}, ${namePart}` : data.lastName;
      const locationLine = [data.billingCity, data.billingCountry]
        .filter(Boolean)
        .join(" ") || null;

      y = ensureSpace(doc, y, 80);
      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine,
          secondLine: data.jobTitle || data.organization,
          locationLine,
        },
        meta: [
          { label: "Date", value: formatDateShort(data.date) },
          { label: "Quote Reference", value: data.quoteNumber },
        ],
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
      y = ensureSpace(doc, y, 90);
      y = drawTotals(doc, y, {
        currency: data.currency,
        subtotal: data.price,
        discountAmount: 0,
        discountLabel: null,
        taxRate: data.taxRate,
        taxLabel: data.taxLabel,
      });

      // ── 5. Important notes (matches sample) + VAT disclaimer ──
      const showVatDisclaimer = !!data.taxRate && data.taxRate > 0;
      y = ensureSpace(doc, y, 120);
      y = drawNotesAndDisclaimer(doc, y, QUOTE_NOTES, showVatDisclaimer);

      // ── 6. Bank details ──
      if (data.bankDetails) {
        y = ensureSpace(doc, y, 90);
        drawBankDetails(doc, y, data.bankDetails);
      }

      // ── 7. Footers — written after content so Page N/M reflects real layout ──
      drawFooters(doc, data.date);

      doc.end();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "quote-pdf:render-failed",
        quoteNumber: data.quoteNumber,
        eventName: data.eventName,
      });
      reject(err);
    }
  });
}
