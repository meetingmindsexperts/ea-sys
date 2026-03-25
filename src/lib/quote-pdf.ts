import PDFDocument from "pdfkit";
import { formatDate } from "@/lib/utils";

interface QuoteData {
  quoteNumber: string;
  date: Date;
  validUntil?: Date;
  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;
  // Registrant
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  // Line items
  registrationType: string;
  pricingTier: string | null;
  price: number;
  currency: string;
  taxRate: number | null;
  taxLabel: string;
  // Payment info
  bankDetails: string | null;
  supportEmail: string | null;
  // Organization
  organizationName: string;
}

/**
 * Generates a registration quote/proforma invoice as a PDF buffer.
 */
export async function generateQuotePDF(data: QuoteData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - 100; // 50 margin each side
      const primaryColor = "#00aade";

      // ── Header ──
      doc.rect(0, 0, doc.page.width, 4).fill(primaryColor);

      doc.fontSize(20).fillColor(primaryColor).font("Helvetica-Bold")
        .text(data.organizationName, 50, 30);

      doc.fontSize(10).fillColor("#64748b").font("Helvetica")
        .text("REGISTRATION QUOTE", 50, 55);

      // Quote info box (right aligned)
      const infoX = 350;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica")
        .text("Quote Number:", infoX, 30)
        .text("Date:", infoX, 44)
        .text("Valid Until:", infoX, 58);

      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold")
        .text(data.quoteNumber, infoX + 80, 30)
        .text(formatDate(data.date), infoX + 80, 44)
        .text(data.validUntil ? formatDate(data.validUntil) : "30 days", infoX + 80, 58);

      // ── Divider ──
      doc.moveTo(50, 80).lineTo(50 + pageWidth, 80).lineWidth(0.5).strokeColor("#e2e8f0").stroke();

      // ── Event Details ──
      let y = 95;
      doc.fontSize(11).fillColor(primaryColor).font("Helvetica-Bold")
        .text(data.eventName, 50, y);
      y += 18;

      const eventDetails = [
        formatDate(data.eventDate),
        data.eventVenue,
        data.eventCity,
      ].filter(Boolean).join(" · ");

      doc.fontSize(9).fillColor("#64748b").font("Helvetica")
        .text(eventDetails, 50, y);
      y += 25;

      // ── Bill To ──
      doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold")
        .text("BILL TO", 50, y);
      y += 14;

      const nameStr = [data.title, data.firstName, data.lastName].filter(Boolean).join(" ");
      doc.fontSize(10).fillColor("#1e293b").font("Helvetica-Bold")
        .text(nameStr, 50, y);
      y += 14;

      doc.fontSize(9).fillColor("#475569").font("Helvetica");
      if (data.organization) {
        doc.text(data.organization, 50, y);
        y += 13;
      }
      doc.text(data.email, 50, y);
      y += 25;

      // ── Line Items Table ──
      const tableTop = y;
      const colDesc = 50;
      const colQty = 340;
      const colRate = 400;
      const colAmount = 470;

      // Table header
      doc.rect(50, tableTop, pageWidth, 22).fill("#f8fafc");
      doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold")
        .text("DESCRIPTION", colDesc + 8, tableTop + 7)
        .text("QTY", colQty, tableTop + 7)
        .text("RATE", colRate, tableTop + 7)
        .text("AMOUNT", colAmount, tableTop + 7);

      // Line item
      const rowY = tableTop + 28;
      const itemDesc = data.pricingTier
        ? `${data.registrationType} — ${data.pricingTier}`
        : data.registrationType;

      doc.fontSize(9).fillColor("#1e293b").font("Helvetica")
        .text(itemDesc, colDesc + 8, rowY)
        .text("1", colQty, rowY)
        .text(`${data.currency} ${data.price.toFixed(2)}`, colRate, rowY)
        .text(`${data.currency} ${data.price.toFixed(2)}`, colAmount, rowY);

      // Subtotal / Tax / Total
      y = rowY + 30;
      doc.moveTo(50, y).lineTo(50 + pageWidth, y).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      y += 12;

      const subtotal = data.price;
      const taxAmount = data.taxRate ? subtotal * (data.taxRate / 100) : 0;
      const total = subtotal + taxAmount;

      // Subtotal
      doc.fontSize(9).fillColor("#64748b").font("Helvetica")
        .text("Subtotal", colRate, y);
      doc.fillColor("#1e293b").font("Helvetica")
        .text(`${data.currency} ${subtotal.toFixed(2)}`, colAmount, y);
      y += 16;

      // Tax
      if (data.taxRate && data.taxRate > 0) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica")
          .text(`${data.taxLabel} (${data.taxRate}%)`, colRate, y);
        doc.fillColor("#1e293b").font("Helvetica")
          .text(`${data.currency} ${taxAmount.toFixed(2)}`, colAmount, y);
        y += 16;
      }

      // Total
      doc.rect(colRate - 10, y - 2, pageWidth - colRate + 60, 22).fill(primaryColor);
      doc.fontSize(10).fillColor("#ffffff").font("Helvetica-Bold")
        .text("TOTAL", colRate, y + 3)
        .text(`${data.currency} ${total.toFixed(2)}`, colAmount, y + 3);

      y += 40;

      // ── Payment Instructions ──
      if (data.bankDetails) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold")
          .text("PAYMENT INSTRUCTIONS", 50, y);
        y += 14;

        doc.fontSize(8).fillColor("#475569").font("Helvetica");
        const bankLines = data.bankDetails.split("\n");
        for (const line of bankLines) {
          doc.text(line.trim(), 50, y, { width: pageWidth });
          y += 12;
        }
        y += 10;
      }

      // ── Notes ──
      doc.fontSize(8).fillColor("#94a3b8").font("Helvetica")
        .text("• Payment can be made via credit card, bank transfer, or onsite.", 50, y);
      y += 12;
      doc.text("• Registration will only be confirmed once full payment has been received.", 50, y);
      y += 12;
      doc.text("• Please quote the reference number above when making payment.", 50, y);

      if (data.supportEmail) {
        y += 20;
        doc.fontSize(8).fillColor("#64748b").font("Helvetica")
          .text(`For inquiries: ${data.supportEmail}`, 50, y);
      }

      // ── Footer bar ──
      doc.rect(0, doc.page.height - 4, doc.page.width, 4).fill(primaryColor);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
