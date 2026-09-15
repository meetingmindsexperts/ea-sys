/**
 * CRM quote PDF (Sep 15, 2026). Layout follows the owner's sample quote
 * (title and date box, prepared for / valid till / prepared by, a product table
 * with code, name and description, quantity, unit price and total, then totals,
 * terms and the digital-signature line) under the company's own header, logo
 * and footer from the shared layout engine.
 *
 * Server-only (pdfkit). Every figure printed here is a STORED figure passed in
 * by the service; nothing is recomputed, so the PDF cannot disagree with the row.
 */
import PDFDocument from "pdfkit";
import {
  COLOR_BORDER,
  COLOR_MUTED,
  COLOR_RULE,
  COLOR_TEXT,
  CONTENT_BOTTOM_LIMIT,
  PAGE_MARGIN,
  drawFooters,
  drawHeader,
  drawInfoBoxes,
  ensureSpace,
} from "@/lib/pdf/document-layout";
import {
  QUOTE_DIGITAL_NOTE,
  formatQuoteDate,
  formatQuoteMoney,
  formatTaxRate,
} from "@/crm/lib/quote-rules";

export interface QuotePdfLine {
  productCode: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface QuotePdfInput {
  company: {
    name: string;
    addressLines: string[];
    taxId: string | null;
    logoBuffer: Buffer | null;
  };
  number: string;
  title: string;
  currency: string;
  quoteDate: string;
  validUntil: string;
  preparedByName: string;
  preparedFor: string;
  attention: string | null;
  locationLine: string | null;
  eventName: string | null;
  lines: QuotePdfLine[];
  subtotal: number;
  taxRate: number | null;
  taxLabel: string;
  taxAmount: number;
  total: number;
  terms: string | null;
  notes: string | null;
  generatedAt: Date;
}

const HEADER_FILL = "#eef2f6";
const CELL_PAD = 6;
const TABLE_HEADER_HEIGHT = 22;

type Doc = PDFKit.PDFDocument;

interface Column {
  label: string;
  width: number;
  align: "left" | "right";
}

function contentWidth(doc: Doc): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

/** Code, name (takes the remaining width), quantity, unit price, total price. */
function tableColumns(width: number): [Column, Column, Column, Column, Column] {
  const code = 72;
  const qty = 52;
  const unit = 104;
  const total = 104;
  return [
    { label: "Product code", width: code, align: "left" },
    { label: "Product name", width: width - code - qty - unit - total, align: "left" },
    { label: "Quantity", width: qty, align: "right" },
    { label: "Unit price", width: unit, align: "right" },
    { label: "Total price", width: total, align: "right" },
  ];
}

function drawTitleBox(doc: Doc, y: number, title: string, dateLabel: string): number {
  const width = contentWidth(doc);
  const titleWidth = width * 0.68;
  doc.fontSize(11).font("Helvetica-Bold");
  const titleHeight = doc.heightOfString(title, { width: titleWidth });
  const height = Math.max(34, titleHeight + 22);

  doc.lineWidth(0.5).strokeColor(COLOR_BORDER).rect(PAGE_MARGIN, y, width, height).stroke();
  doc.fontSize(11).font("Helvetica-Bold").fillColor(COLOR_TEXT)
    .text(title, PAGE_MARGIN + 10, y + 11, { width: titleWidth });
  doc.fontSize(9).font("Helvetica").fillColor(COLOR_MUTED)
    .text(`Date: ${dateLabel}`, PAGE_MARGIN, y + 12, { width: width - 10, align: "right", lineBreak: false });
  return y + height + 12;
}

function drawTableHeader(doc: Doc, y: number, cols: Column[]): number {
  const width = contentWidth(doc);
  doc.save().rect(PAGE_MARGIN, y, width, TABLE_HEADER_HEIGHT).fill(HEADER_FILL).restore();
  doc.lineWidth(0.5).strokeColor(COLOR_BORDER).rect(PAGE_MARGIN, y, width, TABLE_HEADER_HEIGHT).stroke();

  let x = PAGE_MARGIN;
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR_TEXT);
  for (const col of cols) {
    doc.text(col.label, x + CELL_PAD, y + 7, {
      width: col.width - CELL_PAD * 2,
      align: col.align,
      lineBreak: false,
    });
    x += col.width;
  }
  return y + TABLE_HEADER_HEIGHT;
}

/** Measured in the same fonts drawRow uses, so a wrapped name never overlaps the next row. */
function rowHeight(doc: Doc, line: QuotePdfLine, cols: Column[]): number {
  const nameWidth = cols[1]!.width - CELL_PAD * 2;
  doc.fontSize(9).font("Helvetica-Bold");
  let nameBlock = doc.heightOfString(line.name, { width: nameWidth });
  if (line.description) {
    doc.fontSize(8).font("Helvetica");
    nameBlock += 3 + doc.heightOfString(line.description, { width: nameWidth });
  }
  doc.fontSize(9).font("Helvetica");
  const codeBlock = line.productCode
    ? doc.heightOfString(line.productCode, { width: cols[0]!.width - CELL_PAD * 2 })
    : 0;
  return Math.max(nameBlock, codeBlock, 12) + CELL_PAD * 2;
}

function drawRow(doc: Doc, y: number, height: number, line: QuotePdfLine, cols: Column[], currency: string): void {
  const width = contentWidth(doc);
  doc.lineWidth(0.5).strokeColor(COLOR_BORDER).rect(PAGE_MARGIN, y, width, height).stroke();

  let divider = PAGE_MARGIN;
  for (let i = 0; i < cols.length - 1; i++) {
    divider += cols[i]!.width;
    doc.moveTo(divider, y).lineTo(divider, y + height).stroke();
  }

  const top = y + CELL_PAD;
  let x = PAGE_MARGIN;
  const [codeCol, nameCol, qtyCol, unitCol, totalCol] = cols as [Column, Column, Column, Column, Column];

  doc.fontSize(9).font("Helvetica").fillColor(COLOR_TEXT)
    .text(line.productCode ?? "", x + CELL_PAD, top, { width: codeCol.width - CELL_PAD * 2 });
  x += codeCol.width;

  const nameWidth = nameCol.width - CELL_PAD * 2;
  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR_TEXT);
  const nameHeight = doc.heightOfString(line.name, { width: nameWidth });
  doc.text(line.name, x + CELL_PAD, top, { width: nameWidth });
  if (line.description) {
    doc.fontSize(8).font("Helvetica").fillColor(COLOR_MUTED)
      .text(line.description, x + CELL_PAD, top + nameHeight + 3, { width: nameWidth });
  }
  x += nameCol.width;

  // Numbers never wrap: a wrapped amount would grow the row past its measured height.
  doc.fontSize(9).font("Helvetica").fillColor(COLOR_TEXT)
    .text(String(line.quantity), x + CELL_PAD, top, { width: qtyCol.width - CELL_PAD * 2, align: "right", lineBreak: false });
  x += qtyCol.width;
  doc.text(formatQuoteMoney(line.unitPrice, currency), x + CELL_PAD, top, {
    width: unitCol.width - CELL_PAD * 2,
    align: "right",
    lineBreak: false,
  });
  x += unitCol.width;
  doc.text(formatQuoteMoney(line.amount, currency), x + CELL_PAD, top, {
    width: totalCol.width - CELL_PAD * 2,
    align: "right",
    lineBreak: false,
  });
}

function drawTotalsBlock(doc: Doc, y: number, input: QuotePdfInput): number {
  const width = contentWidth(doc);
  const labelX = PAGE_MARGIN + width * 0.45;
  const labelWidth = width * 0.32;
  const valueX = labelX + labelWidth;
  const valueWidth = PAGE_MARGIN + width - valueX;

  const rows: [string, number][] = [["Subtotal", input.subtotal]];
  if (input.taxRate && input.taxRate > 0) {
    rows.push([`${input.taxLabel || "VAT"} (${formatTaxRate(input.taxRate)}%)`, input.taxAmount]);
  }

  for (const [label, amount] of rows) {
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR_TEXT)
      .text(label, labelX, y, { width: labelWidth - 10, align: "right", lineBreak: false });
    doc.fontSize(9).font("Helvetica").fillColor(COLOR_TEXT)
      .text(formatQuoteMoney(amount, input.currency), valueX, y, { width: valueWidth, align: "right", lineBreak: false });
    y += 15;
  }

  doc.lineWidth(0.5).strokeColor(COLOR_RULE).moveTo(labelX, y).lineTo(PAGE_MARGIN + width, y).stroke();
  y += 8;
  doc.fontSize(11).font("Helvetica-Bold").fillColor(COLOR_TEXT)
    .text("Total", labelX, y, { width: labelWidth - 10, align: "right", lineBreak: false });
  doc.text(formatQuoteMoney(input.total, input.currency), valueX, y, { width: valueWidth, align: "right", lineBreak: false });
  return y + 26;
}

/** A heading and a paragraph. pdfkit flows a long paragraph onto the next page on its own. */
function drawTextBlock(doc: Doc, y: number, heading: string, body: string): number {
  const width = contentWidth(doc);
  y = ensureSpace(doc, y, 48);
  doc.fontSize(11).font("Helvetica-Bold").fillColor(COLOR_TEXT).text(heading, PAGE_MARGIN, y, { width });
  y += 17;
  doc.fontSize(8.5).font("Helvetica").fillColor(COLOR_TEXT).text(body, PAGE_MARGIN, y, { width, align: "left" });
  return doc.y + 14;
}

export function renderQuotePdf(input: QuotePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: PAGE_MARGIN,
        bufferPages: true,
        info: { Title: `${input.number} ${input.title}` },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: input.company.name,
          addressLines: input.company.addressLines,
          taxId: input.company.taxId,
        },
        centerTitle: input.eventName ?? input.preparedFor,
        documentTitle: "QUOTATION / ESTIMATE",
        logoBuffer: input.company.logoBuffer,
      });

      y = drawTitleBox(doc, y, input.title, formatQuoteDate(input.quoteDate));

      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine: input.preparedFor,
          secondLine: input.attention ? `Attn: ${input.attention}` : null,
          locationLine: input.locationLine,
        },
        meta: [
          { label: "Quote #", value: input.number },
          { label: "Valid till", value: formatQuoteDate(input.validUntil) },
          { label: "Prepared by", value: input.preparedByName },
          ...(input.eventName ? [{ label: "Event", value: input.eventName }] : []),
        ],
      });

      const cols = tableColumns(contentWidth(doc));
      y = ensureSpace(doc, y, TABLE_HEADER_HEIGHT + 40);
      y = drawTableHeader(doc, y, cols);
      for (const line of input.lines) {
        const height = rowHeight(doc, line, cols);
        if (y + height > CONTENT_BOTTOM_LIMIT(doc.page.height)) {
          doc.addPage();
          y = drawTableHeader(doc, PAGE_MARGIN, cols);
        }
        drawRow(doc, y, height, line, cols, input.currency);
        y += height;
      }

      y = ensureSpace(doc, y + 14, 70);
      y = drawTotalsBlock(doc, y, input);

      if (input.terms?.trim()) y = drawTextBlock(doc, y, "Terms and Conditions", input.terms.trim());
      if (input.notes?.trim()) y = drawTextBlock(doc, y, "Notes", input.notes.trim());

      y = ensureSpace(doc, y, 20);
      doc.fontSize(8).font("Helvetica-Oblique").fillColor(COLOR_MUTED)
        .text(QUOTE_DIGITAL_NOTE, PAGE_MARGIN, y, { width: contentWidth(doc) });

      drawFooters(doc, input.generatedAt);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
