/**
 * Speaker reimbursement claim as a PDF. SERVER ONLY (pdfkit).
 *
 * Owner decisions (Sep 15, 2026):
 *   - Download only. The route renders on demand and nothing is stored, so the
 *     file always matches the current submission and no extra copy of bank
 *     details sits in storage or in inboxes.
 *   - Full details. Finance wires the money from this document, so bank
 *     details and the passport number are printed in full. Who may download is
 *     the reimbursement boundary (SUPER_ADMIN / ADMIN / ORGANIZER).
 *   - Documents are LISTED, not merged. The receipts and passport copy stay in
 *     the console; merging up to 15 files of 10 MB would put a large buffer on
 *     the box that also serves the registration desk.
 *
 * Layout reuses the shared document header and footers, so the claim reads as
 * the same family as the invoice and quote. Every user-typed string goes
 * through sanitizePdfText: Helvetica's WinAnsi encoding cannot print Arabic or
 * CJK, and one such character in a bank address must not fail the document.
 */
import PDFDocument from "pdfkit";
import {
  COLOR_MUTED,
  COLOR_RULE,
  COLOR_TEXT,
  PAGE_MARGIN,
  drawFooters,
  drawHeader,
  ensureSpace,
  formatDateShort,
  formatFooterTimestamp,
  loadLocalLogo,
  toAddressLines,
} from "@/lib/pdf/document-layout";
import { sanitizePdfText } from "@/lib/pdf/pdf-text";
import { formatFileSize } from "@/lib/utils";
import {
  BANK_FIELD_LABELS,
  REIMBURSEMENT_CURRENCIES,
  claimItemLabel,
  claimLineSchema,
  computeClaimTotals,
  documentKindLabel,
  type ClaimLine,
} from "@/lib/reimbursement/constants";

export interface ReimbursementPdfData {
  reimbursementId: string;
  generatedAt: Date;
  organization: {
    name: string;
    logo: string | null;
    companyName: string | null;
    companyAddress: string | null;
    companyCity: string | null;
    companyState: string | null;
    companyZipCode: string | null;
    companyCountry: string | null;
    taxId: string | null;
  };
  event: {
    name: string;
    startDate: Date;
    endDate: Date | null;
    venue: string | null;
    city: string | null;
  };
  speaker: {
    fullName: string | null;
    designation: string | null;
    institution: string | null;
    country: string | null;
    email: string | null;
    phone: string | null;
    nationality: string | null;
    passportNumber: string | null;
    roleAtEvent: string | null;
  };
  /** Raw JSON column; read defensively by readClaimLines. */
  claimLines: unknown;
  /** Raw JSON column; only string values are printed. */
  bankDetails: unknown;
  documents: { kind: string; filename: string; size: number }[];
  signedName: string | null;
  submittedAt: Date | null;
}

/**
 * The stored claim lines, keeping only lines that still parse. The column is
 * JSON written by the public submit, so a malformed line is not expected; if one
 * exists it is left out of the document rather than printed as NaN, and the
 * route logs how many were dropped.
 */
export function readClaimLines(value: unknown): { lines: ClaimLine[]; dropped: number } {
  if (!Array.isArray(value)) return { lines: [], dropped: 0 };
  const lines: ClaimLine[] = [];
  for (const raw of value) {
    const parsed = claimLineSchema.safeParse(raw);
    if (parsed.success) lines.push(parsed.data);
  }
  return { lines, dropped: value.length - lines.length };
}

function readBankValue(bankDetails: unknown, key: string): string | null {
  if (!bankDetails || typeof bankDetails !== "object") return null;
  const v = (bankDetails as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const money = (currency: string, amount: number) =>
  `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const t = (s: string | null | undefined) => sanitizePdfText(s ?? "");

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, y: number, title: string): number {
  // Keep a title with at least its first row, never alone at a page foot.
  y = ensureSpace(doc, y, 48);
  doc.fontSize(10).fillColor(COLOR_TEXT).font("Helvetica-Bold").text(t(title), PAGE_MARGIN, y);
  y += 14;
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + contentWidth(doc), y).stroke();
  return y + 8;
}

/**
 * Label-over-value pairs in two columns. Row height is MEASURED, so a long bank
 * address wraps inside its column instead of drawing over the row below.
 */
function drawFields(
  doc: PDFKit.PDFDocument,
  y: number,
  fields: [string, string | null | undefined][],
): number {
  const gap = 20;
  const colWidth = (contentWidth(doc) - gap) / 2;
  for (let i = 0; i < fields.length; i += 2) {
    const pair = fields.slice(i, i + 2);
    doc.fontSize(9).font("Helvetica");
    const rowHeight =
      Math.max(...pair.map(([, value]) => doc.heightOfString(t(value?.trim() || "-"), { width: colWidth }))) + 17;
    y = ensureSpace(doc, y, rowHeight);
    pair.forEach(([label, value], j) => {
      const x = PAGE_MARGIN + j * (colWidth + gap);
      doc.fontSize(7.5).fillColor(COLOR_MUTED).font("Helvetica").text(t(label), x, y, { width: colWidth });
      doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
        .text(t(value?.trim() || "-"), x, y + 10, { width: colWidth });
    });
    y += rowHeight;
  }
  return y;
}

function drawClaim(doc: PDFKit.PDFDocument, y: number, lines: ClaimLine[]): number {
  const width = contentWidth(doc);
  const amountWidth = 150;
  const amountX = PAGE_MARGIN + width - amountWidth;

  if (lines.length === 0) {
    doc.fontSize(9).fillColor(COLOR_MUTED).font("Helvetica").text("No claim lines.", PAGE_MARGIN, y);
    return y + 16;
  }

  for (const line of lines) {
    y = ensureSpace(doc, y, 16);
    doc.fontSize(9).fillColor(COLOR_TEXT).font("Helvetica")
      .text(t(claimItemLabel(line.item)), PAGE_MARGIN, y, { width: width - amountWidth - 10 });
    doc.text(money(line.currency, line.amount), amountX, y, { width: amountWidth, align: "right" });
    y += 16;
  }

  y = ensureSpace(doc, y, 20);
  doc.lineWidth(0.5).strokeColor(COLOR_RULE).moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + width, y).stroke();
  y += 6;

  // One total per currency. A claim in USD and AED has no single total, and
  // adding the two would print a number nobody could pay.
  const totals = computeClaimTotals(lines);
  for (const currency of REIMBURSEMENT_CURRENCIES) {
    const total = totals[currency];
    if (total == null) continue;
    y = ensureSpace(doc, y, 16);
    doc.fontSize(9.5).fillColor(COLOR_TEXT).font("Helvetica-Bold")
      .text(`Total (${currency})`, PAGE_MARGIN, y, { width: width - amountWidth - 10 });
    doc.text(money(currency, total), amountX, y, { width: amountWidth, align: "right" });
    y += 16;
  }
  return y + 4;
}

export async function generateReimbursementPdf(data: ReimbursementPdfData): Promise<Buffer> {
  // Read before opening the document: pdfkit writes synchronously.
  const logoBuffer = await loadLocalLogo(data.organization.logo);
  const { lines } = readClaimLines(data.claimLines);
  const org = data.organization;
  const cityLine = [org.companyCity, org.companyState, org.companyZipCode].filter(Boolean).join(", ");

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: t(org.companyName || org.name),
          addressLines: toAddressLines(org.companyAddress, cityLine, org.companyCountry).map(t),
          taxId: org.taxId,
        },
        centerTitle: t(data.event.name),
        documentTitle: "REIMBURSEMENT CLAIM",
        logoBuffer,
      });

      doc.fontSize(7.5).fillColor(COLOR_MUTED).font("Helvetica")
        .text(
          "Confidential: this document contains bank and passport details. Share it only with the people processing the payment.",
          PAGE_MARGIN,
          y,
          { width: contentWidth(doc) },
        );
      y += 18;

      const eventDates = data.event.endDate && formatDateShort(data.event.endDate) !== formatDateShort(data.event.startDate)
        ? `${formatDateShort(data.event.startDate)} - ${formatDateShort(data.event.endDate)}`
        : formatDateShort(data.event.startDate);

      y = drawSectionTitle(doc, y, "Claim");
      y = drawFields(doc, y, [
        ["Claim reference", data.reimbursementId.slice(-8).toUpperCase()],
        ["Submitted", data.submittedAt ? formatFooterTimestamp(data.submittedAt) : null],
        ["Event", data.event.name],
        ["Event dates", eventDates],
        ["Venue", [data.event.venue, data.event.city].filter(Boolean).join(", ") || null],
      ]);
      y += 6;

      const s = data.speaker;
      y = drawSectionTitle(doc, y, "Speaker / faculty details");
      y = drawFields(doc, y, [
        ["Full name (as on passport)", s.fullName],
        ["Role at event", s.roleAtEvent],
        ["Designation", s.designation],
        ["Institution", s.institution],
        ["Email", s.email],
        ["Phone", s.phone],
        ["Country of residence", s.country],
        ["Nationality", s.nationality],
        ["Passport number", s.passportNumber],
      ]);
      y += 6;

      y = drawSectionTitle(doc, y, "Amounts claimed");
      y = drawClaim(doc, y, lines);
      y += 6;

      y = drawSectionTitle(doc, y, "Bank transfer details");
      y = drawFields(
        doc,
        y,
        BANK_FIELD_LABELS.map(([key, label]) => [label, readBankValue(data.bankDetails, key)]),
      );
      y += 6;

      y = drawSectionTitle(doc, y, "Supporting documents");
      if (data.documents.length === 0) {
        doc.fontSize(9).fillColor(COLOR_MUTED).font("Helvetica").text("None uploaded.", PAGE_MARGIN, y);
        y += 16;
      } else {
        for (const d of data.documents) {
          const line = `${documentKindLabel(d.kind)}: ${d.filename} (${formatFileSize(d.size)})`;
          doc.fontSize(9).font("Helvetica");
          const h = doc.heightOfString(t(line), { width: contentWidth(doc) });
          y = ensureSpace(doc, y, h + 4);
          doc.fillColor(COLOR_TEXT).text(t(line), PAGE_MARGIN, y, { width: contentWidth(doc) });
          y += h + 4;
        }
        y = ensureSpace(doc, y, 14);
        doc.fontSize(7.5).fillColor(COLOR_MUTED).font("Helvetica")
          .text("The files themselves are kept in EA-SYS, under the speaker's reimbursement.", PAGE_MARGIN, y);
        y += 14;
      }
      y += 6;

      y = drawSectionTitle(doc, y, "Declaration");
      const declaration = data.submittedAt
        ? `Signed "${data.signedName ?? ""}" on ${formatFooterTimestamp(data.submittedAt)}, as a typed-name electronic signature on the reimbursement form.`
        : "Not signed.";
      doc.fontSize(9).font("Helvetica");
      const dh = doc.heightOfString(t(declaration), { width: contentWidth(doc) });
      y = ensureSpace(doc, y, dh);
      doc.fillColor(COLOR_TEXT).text(t(declaration), PAGE_MARGIN, y, { width: contentWidth(doc) });

      drawFooters(doc, data.generatedAt);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
