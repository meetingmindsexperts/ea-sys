import PDFDocument from "pdfkit";
import { formatDate } from "@/lib/utils";

export interface ReceiptPDFData {
  // Document identity
  receiptNumber: string;
  paymentDate: Date;
  paymentMethod: string | null;
  paymentReference: string | null;
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
  // Received From
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
  /** STORED figures from the receipt row (review M10). */
  taxAmount?: number | null;
  total?: number | null;
  currency: string;
  taxRate: number | null;
  taxLabel: string;
  discountCode: string | null;
  discountAmount: number;
}

export async function generateReceiptPDF(data: ReceiptPDFData): Promise<Buffer> {
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
      doc.fontSize(10).fillColor("#64748b").font("Helvetica")
        .text("PAYMENT RECEIPT", 50, 55);

      // ── Receipt info (right) ──
      // Values get an explicit column width and the rows flow from the
      // measured height of the previous one — "Credit/Debit Card (Stripe)"
      // wraps to two lines, and with the old fixed y-positions its second
      // line overlapped the Reference row.
      const infoX = 350;
      const infoValX = infoX + 100;
      const infoValW = 50 + pageWidth - infoValX;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica")
        .text("Receipt Number:", infoX, 30)
        .text("Payment Date:", infoX, 44)
        .text("Payment Method:", infoX, 58);

      const methodStr = formatPaymentMethod(data.paymentMethod);
      doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold")
        .text(data.receiptNumber, infoValX, 30, { width: infoValW })
        .text(formatDate(data.paymentDate), infoValX, 44, { width: infoValW })
        .text(methodStr, infoValX, 58, { width: infoValW });
      let infoY = Math.max(72, 58 + doc.heightOfString(methodStr, { width: infoValW }) + 3);

      if (data.paymentReference) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Reference:", infoX, infoY);
        doc.fontSize(9).fillColor("#1e293b").font("Helvetica-Bold")
          .text(data.paymentReference, infoValX, infoY, { width: infoValW });
        infoY += doc.heightOfString(data.paymentReference, { width: infoValW });
      }

      // ── Divider ── (pushed down when the info block wrapped)
      const dividerY = Math.max(90, infoY + 8);
      doc.moveTo(50, dividerY).lineTo(50 + pageWidth, dividerY).lineWidth(0.5).strokeColor("#e2e8f0").stroke();

      // ── From (left) ──
      let y = dividerY + 15;
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
      // "TRN:" to match the shared invoice/quote/credit-note header label.
      if (data.taxId) { doc.text(`TRN: ${data.taxId}`, 50, y); y += 11; }

      // ── Received From (right) ── (starts level with FROM, below the divider)
      let rY = dividerY + 15;
      doc.fontSize(9).fillColor("#64748b").font("Helvetica-Bold").text("RECEIVED FROM", 320, rY);
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

      // ── Line Items ──
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
      const discount = data.discountAmount || 0;
      const discountedSubtotal = Math.max(0, subtotal - discount);
      // Prefer the STORED figures from the receipt row (review M10).
      const taxAmount = data.taxAmount ?? (data.taxRate ? discountedSubtotal * (data.taxRate / 100) : 0);
      const total = data.total ?? discountedSubtotal + taxAmount;

      // Totals column geometry. Labels get their own column starting at
      // totalsLabelX and ending where the amounts begin — a long promo code
      // ("Discount (EHBPU90)") used to be drawn from colRate (400) with NO
      // width cap, running straight underneath the amount (organizer-reported
      // overlap, July 20 2026). Labels wider than the column are truncated
      // with an ellipsis; amounts right-align to the table's right edge so
      // the figures share one clean edge.
      const totalsLabelX = 330;
      const amountRight = 50 + pageWidth;
      const labelMaxW = colAmount - totalsLabelX - 8;
      const amountOpts = { width: amountRight - colAmount, align: "right" as const };

      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text("Subtotal", totalsLabelX, y);
      doc.fillColor("#1e293b").text(`${data.currency} ${subtotal.toFixed(2)}`, colAmount, y, amountOpts);
      y += 16;

      if (discount > 0) {
        const discountLabel = data.discountCode ? `Discount (${data.discountCode})` : "Discount";
        doc.fontSize(9).fillColor("#dc2626").font("Helvetica")
          .text(truncateToWidth(doc, discountLabel, labelMaxW), totalsLabelX, y);
        doc.fillColor("#dc2626").text(`-${data.currency} ${discount.toFixed(2)}`, colAmount, y, amountOpts);
        y += 16;
      }

      if (data.taxRate && data.taxRate > 0) {
        doc.fontSize(9).fillColor("#64748b").font("Helvetica")
          .text(truncateToWidth(doc, `${data.taxLabel} (${data.taxRate}%)`, labelMaxW), totalsLabelX, y);
        doc.fillColor("#1e293b").text(`${data.currency} ${taxAmount.toFixed(2)}`, colAmount, y, amountOpts);
        y += 16;
      }

      doc.rect(totalsLabelX - 10, y - 2, amountRight - totalsLabelX + 10, 22).fill(color);
      doc.fontSize(10).fillColor("#ffffff").font("Helvetica-Bold")
        .text("TOTAL PAID", totalsLabelX, y + 3)
        .text(`${data.currency} ${total.toFixed(2)}`, colAmount, y + 3, {
          width: amountRight - colAmount - 6,
          align: "right",
        });
      y += 50;

      // ── PAID IN FULL stamp ──
      doc.save();
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fontSize(80).fillColor("#22c55e").fillOpacity(0.12).font("Helvetica-Bold")
        .text("PAID", doc.page.width / 2 - 120, doc.page.height / 2 - 40);
      doc.restore();
      doc.fillOpacity(1);

      // ── Thank you ──
      doc.fontSize(10).fillColor("#1e293b").font("Helvetica-Bold")
        .text("Thank you for your payment.", 50, y);

      // ── Footer bar ──
      doc.rect(0, doc.page.height - 4, doc.page.width, 4).fill(color);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Fit a label into its column: measured with the CURRENT doc font/size, so
 * call after fontSize()/font(). "…" is WinAnsi-safe (Helvetica encodes it).
 */
function truncateToWidth(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function formatPaymentMethod(method: string | null): string {
  if (!method) return "Online";
  const labels: Record<string, string> = {
    stripe: "Credit/Debit Card (Stripe)",
    bank_transfer: "Bank Transfer",
    cash: "Cash",
    manual: "Manual Payment",
  };
  return labels[method] || method;
}
