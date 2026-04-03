import PDFDocument from "pdfkit";
import { formatDate } from "@/lib/utils";

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
  // Line items (amounts shown as negative)
  registrationType: string;
  pricingTier: string | null;
  price: number;
  currency: string;
  taxRate: number | null;
  taxLabel: string;
  // Reason
  notes: string | null;
}

export async function generateCreditNotePDF(data: CreditNotePDFData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - 100;
      const color = data.primaryColor || "#00aade";

      // ── Header bar ──
      doc.rect(0, 0, doc.page.width, 4).fill(color);

      // ── Title ──
      doc.fontSize(20).fillColor(color).font("Helvetica-Bold")
        .text(data.companyName || data.orgName, 50, 30);
      doc.fontSize(10).fillColor("#dc2626").font("Helvetica-Bold")
        .text("CREDIT NOTE", 50, 55);

      // ── Info (right) ──
      const infoX = 350;
      let infoY = 30;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Credit Note:", infoX, infoY);
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold").text(data.creditNoteNumber, infoX + 90, infoY);
      infoY += 14;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Issue Date:", infoX, infoY);
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold").text(formatDate(data.issueDate), infoX + 90, infoY);
      infoY += 14;
      if (data.originalInvoiceNumber) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Ref Invoice:", infoX, infoY);
        doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold").text(data.originalInvoiceNumber, infoX + 90, infoY);
      }

      // ── Divider ──
      doc.moveTo(50, 90).lineTo(50 + pageWidth, 90).lineWidth(0.5).strokeColor("#e2e8f0").stroke();

      // ── From (left) ──
      let y = 105;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("FROM", 50, y);
      y += 14;
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold")
        .text(data.companyName || data.orgName, 50, y);
      y += 13;
      doc.fontSize(8).fillColor("#475569").font("Helvetica");
      if (data.companyAddress) { doc.text(data.companyAddress, 50, y); y += 11; }
      const fromCity = [data.companyCity, data.companyState, data.companyZipCode].filter(Boolean).join(", ");
      if (fromCity) { doc.text(fromCity, 50, y); y += 11; }
      if (data.companyCountry) { doc.text(data.companyCountry, 50, y); y += 11; }
      if (data.taxId) { doc.text(`Tax ID: ${data.taxId}`, 50, y); y += 11; }

      // ── Issued To (right) ──
      let rY = 105;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("ISSUED TO", 320, rY);
      rY += 14;
      const nameStr = [data.title, data.firstName, data.lastName].filter(Boolean).join(" ");
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold").text(nameStr, 320, rY);
      rY += 13;
      doc.fontSize(8).fillColor("#475569").font("Helvetica");
      if (data.organization) { doc.text(data.organization, 320, rY); rY += 11; }
      doc.text(data.email, 320, rY); rY += 11;

      y = Math.max(y, rY) + 10;

      // ── Event ──
      doc.fontSize(10).fillColor(color).font("Helvetica-Bold").text(data.eventName, 50, y);
      y += 16;
      const eventDetails = [formatDate(data.eventDate), data.eventVenue, data.eventCity].filter(Boolean).join(" · ");
      doc.fontSize(8).fillColor("#64748b").font("Helvetica").text(eventDetails, 50, y);
      y += 20;

      // ── Line Items (negated) ──
      const colDesc = 50;
      const colQty = 340;
      const colRate = 400;
      const colAmount = 470;

      doc.rect(50, y, pageWidth, 22).fill("#fef2f2");
      doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold")
        .text("DESCRIPTION", colDesc + 8, y + 7)
        .text("QTY", colQty, y + 7)
        .text("RATE", colRate, y + 7)
        .text("CREDIT", colAmount, y + 7);

      const rowY = y + 28;
      const itemDesc = data.pricingTier
        ? `${data.registrationType} — ${data.pricingTier} (Refund)`
        : `${data.registrationType} (Refund)`;

      doc.fontSize(9).fillColor("#dc2626").font("Helvetica")
        .text(itemDesc, colDesc + 8, rowY)
        .text("1", colQty, rowY)
        .text(`-${data.currency} ${data.price.toFixed(2)}`, colRate, rowY)
        .text(`-${data.currency} ${data.price.toFixed(2)}`, colAmount, rowY);

      // ── Totals ──
      y = rowY + 30;
      doc.moveTo(50, y).lineTo(50 + pageWidth, y).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      y += 12;

      const subtotal = data.price;
      const taxAmount = data.taxRate ? subtotal * (data.taxRate / 100) : 0;
      const total = subtotal + taxAmount;

      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Subtotal", colRate, y);
      doc.fillColor("#dc2626").text(`-${data.currency} ${subtotal.toFixed(2)}`, colAmount, y);
      y += 16;

      if (data.taxRate && data.taxRate > 0) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica")
          .text(`${data.taxLabel} (${data.taxRate}%)`, colRate, y);
        doc.fillColor("#dc2626").text(`-${data.currency} ${taxAmount.toFixed(2)}`, colAmount, y);
        y += 16;
      }

      doc.rect(colRate - 10, y - 2, pageWidth - colRate + 60, 22).fill("#dc2626");
      doc.fontSize(10).fillColor("#ffffff").font("Helvetica-Bold")
        .text("TOTAL CREDIT", colRate, y + 3)
        .text(`-${data.currency} ${total.toFixed(2)}`, colAmount, y + 3);
      y += 40;

      // ── Reason ──
      if (data.notes) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("REASON", 50, y);
        y += 14;
        doc.fontSize(9).fillColor("#475569").font("Helvetica").text(data.notes, 50, y, { width: pageWidth });
      }

      // ── Footer bar ──
      doc.rect(0, doc.page.height - 4, doc.page.width, 4).fill(color);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
