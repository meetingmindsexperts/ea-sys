/**
 * The post-event report as a PDF (post-event-report.ts holds the shape). Same header, footer and page
 * breaks as the quote, invoice and order PDFs (src/lib/pdf/document-layout.ts), so a client sees one
 * house style. Every typed text (question, comment, survey label, type name) goes through
 * sanitizePdfText: an Arabic or emoji character must not fail the document. SERVER ONLY.
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { sanitizePdfText } from "@/lib/pdf/pdf-text";
import {
  COLOR_BORDER,
  COLOR_MUTED,
  COLOR_RULE,
  COLOR_TEXT,
  drawFooters,
  drawHeader,
  ensureSpace,
  loadLocalLogo,
  PAGE_MARGIN,
  toAddressLines,
} from "@/lib/pdf/document-layout";
import { percentOf, type PostEventReport, type ReportBreakdown, type ReportSurveyQuestion } from "./post-event-report";
import {
  ARCHIVED_NOTE,
  attendanceLine,
  commentsLeftOutLine,
  commentsShownNote,
  glanceTiles,
  NOT_ENDED_NOTE,
  PRIVACY_NOTE,
  questionsLine,
  questionsListedNote,
  questionTags,
  ratingLine,
  ratingRows,
  registrationsLine,
  reportWhenLine,
  surveyHeading,
} from "./post-event-report-text";

const COLOR_BAR = "#00aade";
const COLOR_TRACK = "#eef2f6";

export interface ReportCompany {
  name: string;
  companyName: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  logoPath: string | null;
}

export async function generatePostEventReportPdf(report: PostEventReport, company: ReportCompany): Promise<Buffer> {
  const logoBuffer = await loadLocalLogo(company.logoPath);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({ err, msg: "post-event-report-pdf:stream-error", eventId: report.event.id });
        reject(err);
      });
      draw(doc, report, company, logoBuffer);
      drawFooters(doc, new Date(report.generatedAt));
      doc.end();
    } catch (err) {
      apiLogger.error({ err, msg: "post-event-report-pdf:render-failed", eventId: report.event.id });
      reject(err);
    }
  });
}

type Doc = PDFKit.PDFDocument;

function contentWidth(doc: Doc): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function draw(doc: Doc, r: PostEventReport, company: ReportCompany, logoBuffer: Buffer | null): void {
  let y = drawHeader(doc, {
    companyBlock: {
      companyName: company.companyName || company.name,
      addressLines: toAddressLines(company.address, [company.city, company.zipCode].filter(Boolean).join(" "), company.country),
      taxId: null,
    },
    centerTitle: sanitizePdfText(r.event.name),
    documentTitle: "POST-EVENT REPORT",
    logoBuffer,
  });

  y = paragraph(doc, y, reportWhenLine(r), { color: COLOR_MUTED, size: 9 });
  if (r.event.status !== "ended") y = paragraph(doc, y, NOT_ENDED_NOTE, { color: "#b45309", size: 9 });
  y = paragraph(doc, y, PRIVACY_NOTE, { color: COLOR_MUTED, size: 8 });

  y = heading(doc, y, "At a glance");
  y = tiles(doc, y, glanceTiles(r));

  y = heading(doc, y, "Registrations");
  y = paragraph(doc, y, registrationsLine(r));
  y = bars(doc, y, r.registrations.byType, r.registrations.registered);

  y = heading(doc, y, "Attendance");
  y = paragraph(doc, y, attendanceLine(r));
  if (r.attendance.archived) y = paragraph(doc, y, ARCHIVED_NOTE, { color: COLOR_MUTED, size: 8 });
  if (r.attendance.devices.length) {
    y = subheading(doc, y, "Watched on");
    y = bars(doc, y, r.attendance.devices, r.attendance.attended);
  }

  y = heading(doc, y, "Questions");
  y = paragraph(doc, y, questionsLine(r));
  r.questions.items.forEach((q, i) => {
    const tags = questionTags(q);
    y = paragraph(doc, y, `${i + 1}. ${sanitizePdfText(q.question)}${tags ? `  (${tags})` : ""}`, { size: 9 });
  });
  const listed = questionsListedNote(r);
  if (listed) y = paragraph(doc, y, listed, { color: COLOR_MUTED, size: 8 });

  if (r.surveys === null) return;
  y = heading(doc, y, "Survey results");
  if (r.surveys.length === 0) {
    paragraph(doc, y, "No survey answers yet.");
    return;
  }
  for (const s of r.surveys) {
    y = subheading(doc, y, sanitizePdfText(surveyHeading(s)));
    for (const q of s.questions) y = surveyQuestion(doc, y, q, r.commentsIncluded);
  }
}

function surveyQuestion(doc: Doc, y: number, q: ReportSurveyQuestion, commentsIncluded: boolean): number {
  y = paragraph(doc, y, sanitizePdfText(q.label), { bold: true, size: 9.5 });
  if (q.type === "rating") {
    y = paragraph(doc, y, ratingLine(q.mean, q.count), { color: COLOR_MUTED, size: 9 });
    return bars(doc, y, ratingRows(q.distribution), q.count);
  }
  if (q.type === "choice") return bars(doc, y, q.options.map((o) => ({ ...o, label: sanitizePdfText(o.label) })), q.count);
  if (!commentsIncluded) return paragraph(doc, y, commentsLeftOutLine(q.count), { color: COLOR_MUTED, size: 9 });
  if (q.comments.length === 0) return paragraph(doc, y, "No comments.", { color: COLOR_MUTED, size: 9 });
  for (const c of q.comments) y = paragraph(doc, y, `"${sanitizePdfText(c)}"`, { size: 9, indent: 8 });
  const shown = commentsShownNote(q.comments.length, q.count);
  if (shown) y = paragraph(doc, y, shown, { color: COLOR_MUTED, size: 8 });
  return y;
}

// ── Drawing primitives ──

function heading(doc: Doc, y: number, text: string): number {
  y = ensureSpace(doc, y + 10, 40);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLOR_TEXT).text(text, PAGE_MARGIN, y);
  y = doc.y + 3;
  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + contentWidth(doc), y).lineWidth(0.5).strokeColor(COLOR_RULE).stroke();
  return y + 6;
}

function subheading(doc: Doc, y: number, text: string): number {
  y = ensureSpace(doc, y + 4, 30);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR_TEXT).text(text, PAGE_MARGIN, y, { width: contentWidth(doc) });
  return doc.y + 4;
}

function paragraph(
  doc: Doc,
  y: number,
  text: string,
  opts: { color?: string; size?: number; bold?: boolean; indent?: number } = {},
): number {
  const width = contentWidth(doc) - (opts.indent ?? 0);
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size ?? 10);
  y = ensureSpace(doc, y, doc.heightOfString(text, { width }) + 4);
  doc.fillColor(opts.color ?? COLOR_TEXT).text(text, PAGE_MARGIN + (opts.indent ?? 0), y, { width });
  return doc.y + 4;
}

function tiles(doc: Doc, y: number, items: { label: string; value: string }[]): number {
  const gap = 8;
  const w = (contentWidth(doc) - gap * (items.length - 1)) / items.length;
  const h = 46;
  y = ensureSpace(doc, y, h + 8);
  items.forEach((t, i) => {
    const x = PAGE_MARGIN + i * (w + gap);
    doc.roundedRect(x, y, w, h, 4).lineWidth(0.5).strokeColor(COLOR_BORDER).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(COLOR_MUTED).text(t.label.toUpperCase(), x + 6, y + 7, { width: w - 12 });
    doc.font("Helvetica-Bold").fontSize(13).fillColor(COLOR_TEXT).text(t.value, x + 6, y + 22, { width: w - 12 });
  });
  return y + h + 8;
}

/** One row per entry: label, count and share, and a bar of the share. */
function bars(doc: Doc, y: number, rows: readonly ReportBreakdown[], total: number): number {
  const width = contentWidth(doc);
  const labelW = width * 0.45;
  const barX = PAGE_MARGIN + labelW + 8;
  const barW = width - labelW - 8 - 70;
  for (const row of rows) {
    y = ensureSpace(doc, y, 16);
    const share = percentOf(row.count, total);
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_TEXT).text(sanitizePdfText(row.label), PAGE_MARGIN, y, { width: labelW, ellipsis: true, height: 12 });
    doc.rect(barX, y + 2, barW, 6).fillColor(COLOR_TRACK).fill();
    if (share > 0) doc.rect(barX, y + 2, Math.max(1, (barW * share) / 100), 6).fillColor(COLOR_BAR).fill();
    doc.fillColor(COLOR_TEXT).text(`${row.count}  ·  ${share}%`, barX + barW + 6, y, { width: 64, align: "right" });
    y += 15;
  }
  return y + 4;
}
