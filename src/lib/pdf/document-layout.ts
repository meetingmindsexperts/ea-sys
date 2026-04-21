/**
 * Shared layout helpers for PDF documents (quote + invoice).
 *
 * The functions in this module are pure drawing routines: each one accepts a
 * pdfkit document plus the current Y position, draws its region, and returns
 * the next Y position. Both `quote-pdf.ts` and `invoice-pdf.ts` compose these
 * helpers to render documents that share a consistent visual identity matching
 * the Meeting Minds reference quote.
 *
 * Receipt PDF intentionally does not use these helpers — it has its own layout
 * with the "PAID IN FULL" watermark and a simpler structure.
 */
import fs from "fs/promises";
import path from "path";
import { apiLogger } from "../logger";

// ── Constants ──
export const PAGE_MARGIN = 50;
export const COLOR_TEXT = "#1f2937";
export const COLOR_MUTED = "#6b7280";
export const COLOR_LIGHT = "#9ca3af";
export const COLOR_BORDER = "#d1d5db";
export const COLOR_RULE = "#e5e7eb";

// ── Date helpers — all output is Asia/Dubai (GST = UTC+4, no DST) ──
//
// We deliberately do not call Date.prototype.getMonth/getDate/getHours, because
// those are local-time on the server (UTC on Vercel and most Docker images,
// Asia/Dubai on the dev machine). Inconsistent server timezones would mean
// every PDF shows a different "Created" timestamp depending on where it ran.
//
// The shift-then-UTC trick mirrors the pattern used in src/lib/utils.ts so all
// dates rendered by EA-SYS — emails, dashboard tables, PDFs — show the same
// Dubai-localized values.

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
function toDubai(date: Date): Date {
  return new Date(date.getTime() + DUBAI_OFFSET_MS);
}

/** Sample-style short date: "4/9/2026" — Asia/Dubai */
export function formatDateShort(date: Date): string {
  const d = toDubai(date);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/** Footer timestamp: "Thu April 09, 2026 12:24:05 PM GST" — Asia/Dubai */
export function formatFooterTimestamp(date: Date): string {
  const d = toDubai(date);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const dayName = days[d.getUTCDay()];
  const monthName = months[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, "0");
  const year = d.getUTCFullYear();
  let hour = d.getUTCHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const second = String(d.getUTCSeconds()).padStart(2, "0");
  return `${dayName} ${monthName} ${day}, ${year} ${hour}:${minute}:${second} ${ampm} GST`;
}

// ── Logo loading ──

/**
 * Loads an org logo for embedding in a PDF.
 *
 * Accepts the raw `Organization.logo` value (any scheme). Only `/uploads/...`
 * paths can be embedded — they're read directly from `public/uploads/` on the
 * EC2 host. Supabase URLs and `https://` URLs are skipped (we'd have to fetch
 * them, which adds latency and a failure mode we don't want in PDF generation).
 *
 * Never throws. Logs a structured warn for every reason a logo was skipped so
 * support can grep `/logs` when an org admin asks "why isn't my logo on the
 * PDF?".
 */
export async function loadLocalLogo(logoPath: string | null): Promise<Buffer | null> {
  if (!logoPath) return null;

  if (!logoPath.startsWith("/uploads/")) {
    apiLogger.warn({
      msg: "pdf:logo-skipped-not-local",
      logoPath,
      hint: "Only /uploads/... paths can be embedded. Re-upload the org logo via the media library.",
    });
    return null;
  }

  try {
    // logoPath = "/uploads/photos/2026/04/abc.png"
    // on disk:  <project>/public/uploads/photos/2026/04/abc.png
    const absolutePath = path.join(process.cwd(), "public", logoPath);
    return await fs.readFile(absolutePath);
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "pdf:logo-read-failed",
      logoPath,
      hint: "File missing or unreadable. PDF will render with empty logo slot.",
    });
    return null;
  }
}

// ── Region 1: header (3 columns) ──

export interface CompanyBlock {
  companyName: string;
  /** address lines, blank/null entries already filtered out */
  addressLines: string[];
  /** rendered as "TRN: <id>" if present */
  taxId: string | null;
}

export interface HeaderInput {
  companyBlock: CompanyBlock;
  /** Centered title (typically the event name in upper case) */
  centerTitle: string;
  /** Document type label rendered below the centered title: "QUOTE" / "INVOICE" / "TAX INVOICE" */
  documentTitle: string;
  logoBuffer: Buffer | null;
}

/**
 * Draws the 3-column top header. Returns the Y position below the header.
 *
 * Layout (from the sample):
 *   ┌──────────────────────┬──────────────────────┬──────────────────────┐
 *   │ Meeting Minds FZ LLC │  EVENT NAME (bold)   │       [logo]         │
 *   │ DSC Tower, Office    │       QUOTE          │                      │
 *   │ No. 508 & 509        │                      │                      │
 *   │ Dubai Studio City    │                      │                      │
 *   │ Dubai 502464         │                      │                      │
 *   │ United Arab Emirates │                      │                      │
 *   │ TRN: 100352048100003 │                      │                      │
 *   └──────────────────────┴──────────────────────┴──────────────────────┘
 */
export function drawHeader(doc: PDFKit.PDFDocument, input: HeaderInput): number {
  const startY = PAGE_MARGIN;
  const pageWidth = doc.page.width;

  // ── Left column: company block ──
  const leftX = PAGE_MARGIN;
  let leftY = startY;
  doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text(input.companyBlock.companyName, leftX, leftY, { width: 180 });
  leftY += 12;

  doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica");
  for (const line of input.companyBlock.addressLines) {
    doc.text(line, leftX, leftY, { width: 180 });
    leftY += 11;
  }
  if (input.companyBlock.taxId) {
    doc.text(`TRN: ${input.companyBlock.taxId}`, leftX, leftY, { width: 180 });
    leftY += 11;
  }

  // ── Center column: event name + document title ──
  const centerWidth = 220;
  const centerX = (pageWidth - centerWidth) / 2;
  let centerY = startY + 12;

  doc.fontSize(11).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text(input.centerTitle.toUpperCase(), centerX, centerY, {
      width: centerWidth,
      align: "center",
    });
  centerY += 32;

  doc.fontSize(16).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text(input.documentTitle, centerX, centerY, {
      width: centerWidth,
      align: "center",
    });

  // ── Right column: logo (top-right) ──
  if (input.logoBuffer) {
    try {
      const logoMaxW = 130;
      const logoMaxH = 70;
      const logoX = pageWidth - PAGE_MARGIN - logoMaxW;
      doc.image(input.logoBuffer, logoX, startY, {
        fit: [logoMaxW, logoMaxH],
        align: "right",
      });
    } catch (err) {
      // Bad image bytes (corrupt file, unsupported codec) — skip rather than
      // crash the whole PDF. Surface to /logs so support can investigate.
      apiLogger.warn({
        err,
        msg: "pdf:logo-image-decode-failed",
        bufferSize: input.logoBuffer.length,
      });
    }
  }

  // Return the lowest of the three columns + a small gap.
  return Math.max(leftY, startY + 90) + 14;
}

// ── Region 2: bill-to + meta info boxes ──

export interface BillToInput {
  /** "Lastname, Dr. Firstname" */
  nameLine: string;
  /** Job title / organization (optional) */
  secondLine: string | null;
  /** Billing street address (optional) — rendered between secondLine and locationLine */
  addressLine?: string | null;
  /** "City, State Zip, Country" (optional) */
  locationLine: string | null;
}

export interface MetaItem {
  label: string;
  value: string;
}

export interface InfoBoxesInput {
  billTo: BillToInput;
  meta: MetaItem[];
}

/**
 * Draws the 2-column boxed row: "To:" billing block on the left, meta fields
 * (Date / Reference / Status / etc.) on the right. Both boxes have identical
 * height equal to the taller of the two.
 *
 * Returns the Y below the boxes.
 */
export function drawInfoBoxes(
  doc: PDFKit.PDFDocument,
  y: number,
  input: InfoBoxesInput
): number {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const gap = 10;
  const leftWidth = (pageWidth - gap) * 0.62;
  const rightWidth = (pageWidth - gap) * 0.38;
  const leftX = PAGE_MARGIN;
  const rightX = PAGE_MARGIN + leftWidth + gap;

  // Compute heights
  const labelLineH = 14;
  const lineH = 12;
  let leftLines = 1; // name line always present
  if (input.billTo.secondLine) leftLines++;
  if (input.billTo.addressLine) leftLines++;
  if (input.billTo.locationLine) leftLines++;
  const leftHeight = 12 + leftLines * lineH + 8;

  const rightLines = input.meta.length;
  const rightHeight = 12 + rightLines * labelLineH + 8;

  const boxHeight = Math.max(leftHeight, rightHeight, 60);

  // ── Left box ──
  doc.lineWidth(0.5).strokeColor(COLOR_BORDER)
    .rect(leftX, y, leftWidth, boxHeight).stroke();

  let lY = y + 10;
  doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text("To:", leftX + 10, lY, { continued: true })
    .font("Helvetica")
    .text(`  ${input.billTo.nameLine}`);
  lY += lineH + 2;
  if (input.billTo.secondLine) {
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica-Bold")
      .text(input.billTo.secondLine, leftX + 30, lY);
    lY += lineH;
  }
  if (input.billTo.addressLine) {
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica-Bold")
      .text(input.billTo.addressLine, leftX + 30, lY);
    lY += lineH;
  }
  if (input.billTo.locationLine) {
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica-Bold")
      .text(input.billTo.locationLine, leftX + 30, lY);
  }

  // ── Right box ──
  doc.lineWidth(0.5).strokeColor(COLOR_BORDER)
    .rect(rightX, y, rightWidth, boxHeight).stroke();

  let rY = y + 10;
  for (const item of input.meta) {
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
      .text(item.label, rightX + 10, rY, { width: rightWidth * 0.45 });
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
      .text(item.value, rightX + rightWidth * 0.5, rY, {
        width: rightWidth * 0.5 - 10,
        align: "left",
      });
    rY += labelLineH;
  }

  return y + boxHeight + 18;
}

// ── Region 3: line items table ──

export interface LineItem {
  description: string;
  amount: number;
}

export interface LineItemCategory {
  name: string;
  items: LineItem[];
}

/**
 * Draws the 2-column line items table:
 *   - Header row: "Details" (italic, left) | "Amount ({currency})" (italic, right)
 *   - For each category: a category label, then indented sub-line(s) with amount
 *
 * Returns Y below the table.
 */
export function drawLineItemsTable(
  doc: PDFKit.PDFDocument,
  y: number,
  currency: string,
  categories: LineItemCategory[]
): number {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const leftX = PAGE_MARGIN;
  const rightX = PAGE_MARGIN + pageWidth;

  // Top rule
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(leftX, y).lineTo(rightX, y).stroke();
  y += 8;

  // Header row (italic)
  doc.fontSize(9).fillColor(COLOR_MUTED).font("Helvetica-Oblique")
    .text("Details", leftX, y, { width: pageWidth * 0.6 });
  doc.text(`Amount (${currency})`, leftX, y, {
    width: pageWidth,
    align: "right",
  });
  y += 16;

  // Bottom rule of header
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(leftX, y).lineTo(rightX, y).stroke();
  y += 10;

  // Categories
  for (const cat of categories) {
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
      .text(cat.name, leftX, y);
    y += 14;

    for (const item of cat.items) {
      doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
        .text(item.description, leftX + 16, y, { width: pageWidth * 0.6 });
      doc.text(item.amount.toFixed(2), leftX, y, {
        width: pageWidth,
        align: "right",
      });
      y += 14;
    }
    y += 4;
  }

  // Bottom rule
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(leftX, y).lineTo(rightX, y).stroke();
  y += 6;

  return y;
}

// ── Region 4: totals — always Subtotal + (Discount) + VAT + Total ──

export interface TotalsInput {
  currency: string;
  /** Pre-tax (net) line-item amount */
  subtotal: number;
  /** 0 if no discount */
  discountAmount: number;
  /** Label like "Discount (PROMO10)" — null when no discount */
  discountLabel: string | null;
  taxRate: number | null;
  taxLabel: string;
  /** Override the "TOTAL OUTSTANDING" label (e.g. "TOTAL PAID" for invoices marked paid) */
  totalLabel?: string;
}

/**
 * Renders the totals block. Always tax-exclusive: stored price is net, VAT
 * added on top.
 *
 *   Subtotal (USD)                 100.00
 *   Discount (PROMO10)             -10.00    (only if applicable)
 *   VAT (5%)                         5.00
 *   ─────────────────────────────────────
 *   TOTAL OUTSTANDING (USD)        105.00    ← bold
 *
 * Returns Y below the block.
 */
export function drawTotals(
  doc: PDFKit.PDFDocument,
  y: number,
  input: TotalsInput
): number {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const leftX = PAGE_MARGIN;
  const labelW = pageWidth * 0.7;
  const totalLabel = input.totalLabel ?? "TOTAL OUTSTANDING";

  const subtotal = input.subtotal;
  const discount = input.discountAmount || 0;
  const discountedSubtotal = Math.max(0, subtotal - discount);
  const taxAmount = input.taxRate ? discountedSubtotal * (input.taxRate / 100) : 0;
  const grandTotal = discountedSubtotal + taxAmount;

  // Subtotal
  doc.fontSize(9).fillColor(COLOR_MUTED).font("Helvetica")
    .text(`Subtotal (${input.currency})`, leftX, y, { width: labelW });
  doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
    .text(subtotal.toFixed(2), leftX, y, { width: pageWidth, align: "right" });
  y += 14;

  if (discount > 0) {
    doc.fontSize(9).fillColor("#dc2626").font("Helvetica")
      .text(input.discountLabel || "Discount", leftX, y, { width: labelW });
    doc.text(`-${discount.toFixed(2)}`, leftX, y, {
      width: pageWidth,
      align: "right",
    });
    y += 14;
  }

  if (input.taxRate && input.taxRate > 0) {
    doc.fontSize(9).fillColor(COLOR_MUTED).font("Helvetica")
      .text(`${input.taxLabel} (${input.taxRate}%)`, leftX, y, { width: labelW });
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
      .text(taxAmount.toFixed(2), leftX, y, {
        width: pageWidth,
        align: "right",
      });
    y += 14;
  }

  // Rule above grand total
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(leftX, y).lineTo(leftX + pageWidth, y).stroke();
  y += 8;

  // Grand total
  doc.fontSize(10).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text(`${totalLabel} (${input.currency})`, leftX, y, { width: labelW });
  doc.fontSize(10).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text(grandTotal.toFixed(2), leftX, y, {
      width: pageWidth,
      align: "right",
    });
  y += 18;

  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(leftX, y).lineTo(leftX + pageWidth, y).stroke();
  y += 14;

  return y;
}

// ── Region 5: Important Notes + VAT disclaimer ──

const VAT_DISCLAIMER =
  "All sums due under this quote are subject to applicable Value Added Tax (or any other sales tax) and if the supplies in respect of which such sums are payable shall be subject to the payment of value added tax or any other sales tax, the amount payable in respect of those supplies shall be increased by such tax thereon at the appropriate rate.";

export function drawNotesAndDisclaimer(
  doc: PDFKit.PDFDocument,
  y: number,
  notes: string[],
  showVatDisclaimer: boolean
): number {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const leftX = PAGE_MARGIN;

  // "Important Notes:" header
  doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text("Important Notes:", leftX, y);
  y += 12;

  // Bullets
  doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica");
  for (const note of notes) {
    const lineHeight = doc.heightOfString(`- ${note}`, { width: pageWidth });
    doc.text(`- ${note}`, leftX, y, { width: pageWidth });
    y += lineHeight + 2;
  }

  if (showVatDisclaimer) {
    y += 8;
    const disclaimerHeight = doc.heightOfString(VAT_DISCLAIMER, { width: pageWidth });
    doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica")
      .text(VAT_DISCLAIMER, leftX, y, { width: pageWidth, align: "left" });
    y += disclaimerHeight + 8;
  }

  return y + 6;
}

// ── Region 6: Bank Details ──

export function drawBankDetails(
  doc: PDFKit.PDFDocument,
  y: number,
  bankDetails: string
): number {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const leftX = PAGE_MARGIN;

  doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica-Bold")
    .text("Bank Details:", leftX, y);
  y += 14;

  doc.fontSize(8).fillColor(COLOR_TEXT).font("Helvetica");
  for (const line of bankDetails.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    doc.text(trimmed, leftX, y, { width: pageWidth });
    y += 11;
  }
  return y + 8;
}

// ── Footer / pagination ──

/** Y position above which content must wrap to a new page (footer reserve). */
export const CONTENT_BOTTOM_LIMIT = (pageHeight: number) => pageHeight - 60;

/**
 * Ensure there's at least `needed` vertical pixels left before the footer
 * reserve. If not, add a new page and return `PAGE_MARGIN` (top of new page).
 *
 * Call this between regions in the document composer:
 *   y = ensureSpace(doc, y, 80);
 *   y = drawNotesAndDisclaimer(doc, y, ...);
 */
export function ensureSpace(
  doc: PDFKit.PDFDocument,
  y: number,
  needed: number
): number {
  if (y + needed > CONTENT_BOTTOM_LIMIT(doc.page.height)) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

/**
 * Draws the footer (Created timestamp + Page N/M) on **every** page in the
 * document, after all content has been written. Call once just before
 * `doc.end()`.
 *
 * Uses pdfkit's `bufferedPageRange()` so it works whether the doc is one page
 * or many — the document must be created with `bufferPages: true` for this to
 * be available.
 */
export function drawFooters(doc: PDFKit.PDFDocument, createdAt: Date): void {
  const range = doc.bufferedPageRange(); // { start, count }
  const totalPages = range.count;
  const timestamp = formatFooterTimestamp(createdAt);

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i);
    const pageWidth = doc.page.width - PAGE_MARGIN * 2;
    const leftX = PAGE_MARGIN;
    const rightX = PAGE_MARGIN + pageWidth;
    const footerY = doc.page.height - 40;

    // Thin rule above
    doc.lineWidth(0.5).strokeColor(COLOR_RULE)
      .moveTo(leftX, footerY).lineTo(rightX, footerY).stroke();

    doc.fontSize(7).fillColor(COLOR_LIGHT).font("Helvetica")
      .text(`Created  ${timestamp}`, leftX, footerY + 8, {
        width: pageWidth * 0.7,
      });
    doc.fontSize(7).fillColor(COLOR_LIGHT).font("Helvetica")
      .text(`Page: ${i + 1}/${totalPages}`, leftX, footerY + 8, {
        width: pageWidth,
        align: "right",
      });
  }
}

/**
 * @deprecated Use {@link drawFooters} after `doc.end()` setup. Kept temporarily
 * for any external caller that hasn't migrated yet — just calls drawFooters.
 */
export function drawFooter(doc: PDFKit.PDFDocument, createdAt: Date): void {
  drawFooters(doc, createdAt);
}
