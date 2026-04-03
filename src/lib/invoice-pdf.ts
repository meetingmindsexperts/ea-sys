import PDFDocument from "pdfkit";
import { formatDate } from "@/lib/utils";

export interface InvoicePDFData {
  // Document identity
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date | null;
  status: string;
  isTaxInvoice: boolean; // true when org has taxId
  // From (organization)
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
  // Bill To
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZipCode: string | null;
  billingCountry: string | null;
  taxNumber: string | null;
  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;
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
}

export async function generateInvoicePDF(data: InvoicePDFData): Promise<Buffer> {
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
      const docTitle = data.isTaxInvoice ? "TAX INVOICE" : "INVOICE";
      doc.fontSize(20).fillColor(color).font("Helvetica-Bold")
        .text(data.companyName || data.orgName, 50, 30);
      doc.fontSize(10).fillColor("#64748b").font("Helvetica")
        .text(docTitle, 50, 55);

      // ── Invoice info (right) ──
      const infoX = 350;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica")
        .text("Invoice Number:", infoX, 30)
        .text("Issue Date:", infoX, 44)
        .text("Due Date:", infoX, 58)
        .text("Status:", infoX, 72);

      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold")
        .text(data.invoiceNumber, infoX + 90, 30)
        .text(formatDate(data.issueDate), infoX + 90, 44)
        .text(data.dueDate ? formatDate(data.dueDate) : "Upon receipt", infoX + 90, 58)
        .text(data.status, infoX + 90, 72);

      // ── Divider ──
      doc.moveTo(50, 90).lineTo(50 + pageWidth, 90).lineWidth(0.5).strokeColor("#e2e8f0").stroke();

      // ── From / Bill To ──
      let y = 105;
      // From (left column)
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
      if (data.companyPhone) { doc.text(data.companyPhone, 50, y); y += 11; }
      if (data.companyEmail) { doc.text(data.companyEmail, 50, y); y += 11; }

      // Bill To (right column)
      let billY = 105;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("BILL TO", 320, billY);
      billY += 14;
      const nameStr = [data.title, data.firstName, data.lastName].filter(Boolean).join(" ");
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold").text(nameStr, 320, billY);
      billY += 13;
      doc.fontSize(8).fillColor("#475569").font("Helvetica");
      if (data.organization) { doc.text(data.organization, 320, billY); billY += 11; }
      doc.text(data.email, 320, billY); billY += 11;
      if (data.billingAddress) { doc.text(data.billingAddress, 320, billY); billY += 11; }
      const billCity = [data.billingCity, data.billingState, data.billingZipCode].filter(Boolean).join(", ");
      if (billCity) { doc.text(billCity, 320, billY); billY += 11; }
      if (data.billingCountry) { doc.text(data.billingCountry, 320, billY); billY += 11; }
      if (data.taxNumber) { doc.text(`Tax No: ${data.taxNumber}`, 320, billY); billY += 11; }

      y = Math.max(y, billY) + 10;

      // ── Event ──
      doc.fontSize(10).fillColor(color).font("Helvetica-Bold").text(data.eventName, 50, y);
      y += 16;
      const eventDetails = [formatDate(data.eventDate), data.eventVenue, data.eventCity].filter(Boolean).join(" · ");
      doc.fontSize(8).fillColor("#64748b").font("Helvetica").text(eventDetails, 50, y);
      y += 20;

      // ── Line Items Table ──
      const colDesc = 50;
      const colQty = 340;
      const colRate = 400;
      const colAmount = 470;

      doc.rect(50, y, pageWidth, 22).fill("#f8fafc");
      doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold")
        .text("DESCRIPTION", colDesc + 8, y + 7)
        .text("QTY", colQty, y + 7)
        .text("RATE", colRate, y + 7)
        .text("AMOUNT", colAmount, y + 7);

      const rowY = y + 28;
      const itemDesc = data.pricingTier
        ? `${data.registrationType} — ${data.pricingTier}`
        : data.registrationType;

      doc.fontSize(9).fillColor("#1e293b").font("Helvetica")
        .text(itemDesc, colDesc + 8, rowY)
        .text("1", colQty, rowY)
        .text(`${data.currency} ${data.price.toFixed(2)}`, colRate, rowY)
        .text(`${data.currency} ${data.price.toFixed(2)}`, colAmount, rowY);

      // ── Totals ──
      y = rowY + 30;
      doc.moveTo(50, y).lineTo(50 + pageWidth, y).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      y += 12;

      const subtotal = data.price;
      const taxAmount = data.taxRate ? subtotal * (data.taxRate / 100) : 0;
      const total = subtotal + taxAmount;

      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Subtotal", colRate, y);
      doc.fillColor("#1e293b").text(`${data.currency} ${subtotal.toFixed(2)}`, colAmount, y);
      y += 16;

      if (data.taxRate && data.taxRate > 0) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica")
          .text(`${data.taxLabel} (${data.taxRate}%)`, colRate, y);
        doc.fillColor("#1e293b").text(`${data.currency} ${taxAmount.toFixed(2)}`, colAmount, y);
        y += 16;
      }

      doc.rect(colRate - 10, y - 2, pageWidth - colRate + 60, 22).fill(color);
      doc.fontSize(10).fillColor("#ffffff").font("Helvetica-Bold")
        .text("TOTAL", colRate, y + 3)
        .text(`${data.currency} ${total.toFixed(2)}`, colAmount, y + 3);
      y += 40;

      // ── PAID watermark ──
      if (data.status === "PAID") {
        doc.save();
        doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.fontSize(80).fillColor("#22c55e").fillOpacity(0.12).font("Helvetica-Bold")
          .text("PAID", doc.page.width / 2 - 120, doc.page.height / 2 - 40);
        doc.restore();
        doc.fillOpacity(1);
      }

      // ── Payment Instructions ──
      if (data.bankDetails && data.status !== "PAID") {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("PAYMENT INSTRUCTIONS", 50, y);
        y += 14;
        doc.fontSize(8).fillColor("#475569").font("Helvetica");
        for (const line of data.bankDetails.split("\n")) {
          doc.text(line.trim(), 50, y, { width: pageWidth });
          y += 12;
        }
        y += 10;
      }

      // ── Notes ──
      if (data.supportEmail) {
        doc.fontSize(8).fillColor("#64748b").font("Helvetica")
          .text(`For inquiries: ${data.supportEmail}`, 50, y);
      }

      // ── Footer bar ──
      doc.rect(0, doc.page.height - 4, doc.page.width, 4).fill(color);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
