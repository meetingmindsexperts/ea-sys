/**
 * The purchase order PDF (spec §5 "using the same layout as our invoices and
 * quotes"; build plan §4.6 "no new renderer"): the shared document layout
 * with the supplier as the bill-to block and one line per order line. Pure
 * over a data object so the service loads and the test renders a sample
 * without a database.
 *
 * The PDF is generated on demand from the stored row (never in bulk, plan
 * §1.2), so the figures a supplier sees are the ones the budget line holds.
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import {
  PAGE_MARGIN,
  drawHeader,
  drawInfoBoxes,
  drawLineItemsTable,
  drawNotesAndDisclaimer,
  drawTotals,
  drawFooters,
  ensureSpace,
  formatDateShort,
  loadLocalLogo,
  toAddressLines,
} from "@/lib/pdf/document-layout";
import { impliedTaxRatePercent } from "./commitment-rules";
import { money } from "./money";

export interface PurchaseOrderPdfLine {
  description: string;
  qty: string;
  unitCost: string;
  amount: string;
  taxRatePercent: string | null;
  taxCode: string | null;
}

export interface PurchaseOrderPdfData {
  commitmentNo: string;
  issuedAt: Date;
  eventName: string | null;
  eventCode: string;
  requestNo: string | null;
  requesterName: string | null;
  currency: string;
  /** Ex-VAT, with the VAT beside it (spec §7); the PDF prints both and the total. */
  amount: string;
  taxAmount: string;
  lines: PurchaseOrderPdfLine[];
  supplier: {
    code: string;
    displayName: string;
    legalName: string;
    country: string | null;
    paymentTerms: string | null;
    contactName: string | null;
    contactEmail: string | null;
  };
  company: {
    name: string;
    companyName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
    phone: string | null;
    email: string | null;
    taxId: string | null;
    logoPath: string | null;
  };
}

const ORDER_NOTES = [
  "Please quote this purchase order number and the event code on your invoice.",
  "Invoices are matched to this order line by line; an invoice without the order number cannot be matched and will be held.",
  "Prices are ex-VAT; the VAT is shown beside them and on your invoice.",
];

/** A line's text on the PDF: the description, then the quantity and unit cost when it is not a single unit. */
export function orderLineText(line: PurchaseOrderPdfLine): string {
  const qty = money(line.qty);
  const parts = [line.description];
  if (!qty.eq(1)) parts.push(`${qty.toString()} × ${money(line.unitCost).toFixed(2)}`);
  if (line.taxCode) parts.push(line.taxCode);
  else if (line.taxRatePercent !== null && money(line.taxRatePercent).gt(0)) parts.push(`VAT ${money(line.taxRatePercent).toString()}%`);
  return parts.join(" · ");
}

export async function generatePurchaseOrderPdf(data: PurchaseOrderPdfData): Promise<Buffer> {
  const logoBuffer = await loadLocalLogo(data.company.logoPath);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({ err, msg: "purchase-order-pdf:stream-error", commitmentNo: data.commitmentNo });
        reject(err);
      });

      const addressLines = toAddressLines(
        data.company.address,
        [data.company.city, data.company.zipCode].filter(Boolean).join(" "),
        data.company.country,
      );
      let y = drawHeader(doc, {
        companyBlock: { companyName: data.company.companyName || data.company.name, addressLines, taxId: data.company.taxId },
        centerTitle: data.eventName ?? data.eventCode,
        documentTitle: "PURCHASE ORDER",
        logoBuffer,
      });

      const meta = [
        { label: "Date", value: formatDateShort(data.issuedAt) },
        { label: "Order Number", value: data.commitmentNo },
        { label: "Event Code", value: data.eventCode },
      ];
      if (data.requestNo) meta.push({ label: "Request", value: data.requestNo });
      if (data.requesterName) meta.push({ label: "Raised by", value: data.requesterName });
      if (data.supplier.paymentTerms) meta.push({ label: "Payment Terms", value: data.supplier.paymentTerms });
      meta.push({ label: "Currency", value: data.currency });

      y = ensureSpace(doc, y, 80);
      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine: data.supplier.displayName,
          secondLine: data.supplier.legalName !== data.supplier.displayName ? data.supplier.legalName : data.supplier.contactName,
          organizationLine: data.supplier.legalName !== data.supplier.displayName ? data.supplier.contactName : null,
          addressLine: data.supplier.contactEmail,
          locationLine: data.supplier.country,
        },
        meta,
      });

      y = ensureSpace(doc, y, 80);
      y = drawLineItemsTable(doc, y, data.currency, [
        { name: `Supplier ${data.supplier.code}`, items: data.lines.map((l) => ({ description: orderLineText(l), amount: Number(money(l.amount).toFixed(2)) })) },
      ]);

      const taxRate = impliedTaxRatePercent(data.amount, data.taxAmount);
      y = ensureSpace(doc, y, 90);
      y = drawTotals(doc, y, {
        currency: data.currency,
        subtotal: Number(money(data.amount).toFixed(2)),
        discountAmount: 0,
        discountLabel: null,
        taxRate,
        taxLabel: "VAT",
        taxAmountOverride: Number(money(data.taxAmount).toFixed(2)),
        grandTotalOverride: Number(money(data.amount).plus(money(data.taxAmount)).toFixed(2)),
        totalLabel: "TOTAL",
      });

      y = ensureSpace(doc, y, 120);
      drawNotesAndDisclaimer(doc, y, ORDER_NOTES, taxRate !== null, "purchase order");
      drawFooters(doc, data.issuedAt);
      doc.end();
    } catch (err) {
      apiLogger.error({ err, msg: "purchase-order-pdf:render-failed", commitmentNo: data.commitmentNo });
      reject(err);
    }
  });
}
