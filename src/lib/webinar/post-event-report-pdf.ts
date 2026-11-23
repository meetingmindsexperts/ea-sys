/**
 * The post-event report as a PDF (post-event-report.ts holds the shape). Same header, footer and page
 * breaks as the quote, invoice and order PDFs (src/lib/pdf/document-layout.ts), so a client sees one
 * house style. Every typed text (question, comment, survey label, type name) goes through
 * sanitizePdfText: an Arabic or emoji character must not fail the document. SERVER ONLY.
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { formatDateTimeInTz } from "@/lib/event-time";
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
import { percentOf, reportDuration, type PostEventReport, type ReportBreakdown, type ReportSurveyQuestion } from "./post-event-report";

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

  y = paragraph(doc, y, whenLine(r), { color: COLOR_MUTED, size: 9 });
  if (r.event.status !== "ended") {
    y = paragraph(doc, y, "The webinar has not ended yet: these figures are so far.", { color: "#b45309", size: 9 });
  }
  y = paragraph(
    doc,
    y,
    "No attendee is named. Questions and comments are attendees' own words, with email addresses and phone numbers removed.",
    { color: COLOR_MUTED, size: 8 },
  );

  y = heading(doc, y, "At a glance");
  y = tiles(doc, y, [
    { label: "Registered", value: String(r.registrations.registered) },
    { label: "Attended", value: `${r.attendance.attended} (${r.attendance.attendanceRate}%)` },
    { label: "Average watched", value: reportDuration(r.attendance.avgWatchSeconds) },
    { label: "Most watching at once", value: String(r.attendance.peak) },
    { label: "Questions asked", value: String(r.questions.asked) },
  ]);

  y = heading(doc, y, "Registrations");
  y = paragraph(
    doc,
    y,
    `${r.registrations.registered} registered: ${r.registrations.confirmed} confirmed, ${r.registrations.pending} pending. ${r.registrations.cancelled} cancelled (not counted).`,
  );
  y = bars(doc, y, r.registrations.byType, r.registrations.registered);

  y = heading(doc, y, "Attendance");
  y = paragraph(doc, y, attendanceLine(r));
  if (r.attendance.archived) {
    y = paragraph(
      doc,
      y,
      "This webinar is more than 90 days old: the minute-by-minute record has been archived, so the time watched, the peak and the devices are not shown.",
      { color: COLOR_MUTED, size: 8 },
    );
  }
  if (r.attendance.devices.length) {
    y = subheading(doc, y, "Watched on");
    y = bars(doc, y, r.attendance.devices, r.attendance.attended);
  }

  y = heading(doc, y, "Questions");
  y = paragraph(doc, y, r.questions.asked === 0 ? "No questions were asked." : `${r.questions.asked} asked, ${r.questions.answered} answered.`);
  r.questions.items.forEach((q, i) => {
    const tags = [q.answered ? "answered" : null, q.votes > 0 ? `${q.votes} vote${q.votes === 1 ? "" : "s"}` : null].filter(Boolean).join(", ");
    y = paragraph(doc, y, `${i + 1}. ${sanitizePdfText(q.question)}${tags ? `  (${tags})` : ""}`, { size: 9 });
  });
  if (r.questions.items.length < r.questions.asked) {
    y = paragraph(doc, y, `The first ${r.questions.items.length} are listed.`, { color: COLOR_MUTED, size: 8 });
  }

  if (r.surveys === null) return;
  y = heading(doc, y, "Survey results");
  if (r.surveys.length === 0) {
    paragraph(doc, y, "No survey answers yet.");
    return;
  }
  for (const s of r.surveys) {
    y = subheading(doc, y, `${sanitizePdfText(s.name)}: ${s.responses} response${s.responses === 1 ? "" : "s"}`);
    for (const q of s.questions) y = surveyQuestion(doc, y, q, r.commentsIncluded);
  }
}

function whenLine(r: PostEventReport): string {
  const tz = r.event.timezone;
  const parts: string[] = [];
  if (r.event.startTime) parts.push(`Webinar: ${formatDateTimeInTz(new Date(r.event.startTime), tz)} (${tz})`);
  parts.push(`Report made ${formatDateTimeInTz(new Date(r.generatedAt), tz)}`);
  return parts.join("   ·   ");
}

function attendanceLine(r: PostEventReport): string {
  const a = r.attendance;
  const source =
    a.source === "page"
      ? "Counted on the webinar page: people who reached the live view, and the minutes they watched while it was open."
      : "From Zoom's participant report.";
  const watched = a.archived ? "" : ` Average watched ${reportDuration(a.avgWatchSeconds)}, ${reportDuration(a.totalWatchSeconds)} in all.`;
  return `${a.attended} attended, ${a.attendanceRate}% of the ${r.registrations.confirmed} confirmed registrations.${watched} ${source}`;
}

function surveyQuestion(doc: Doc, y: number, q: ReportSurveyQuestion, commentsIncluded: boolean): number {
  y = paragraph(doc, y, sanitizePdfText(q.label), { bold: true, size: 9.5 });
  if (q.type === "rating") {
    const mean = q.mean === null ? "no answers" : `${q.mean.toFixed(1)} out of 5`;
    y = paragraph(doc, y, `Average ${mean} (${q.count} answer${q.count === 1 ? "" : "s"})`, { color: COLOR_MUTED, size: 9 });
    const rows = [5, 4, 3, 2, 1].map((stars) => ({ label: `${stars} star${stars === 1 ? "" : "s"}`, count: q.distribution[stars - 1] ?? 0 }));
    return bars(doc, y, rows, q.count);
  }
  if (q.type === "choice") return bars(doc, y, q.options.map((o) => ({ ...o, label: sanitizePdfText(o.label) })), q.count);
  if (!commentsIncluded) {
    return paragraph(doc, y, `${q.count} comment${q.count === 1 ? "" : "s"}, left out of this copy.`, { color: COLOR_MUTED, size: 9 });
  }
  if (q.comments.length === 0) return paragraph(doc, y, "No comments.", { color: COLOR_MUTED, size: 9 });
  for (const c of q.comments) y = paragraph(doc, y, `"${sanitizePdfText(c)}"`, { size: 9, indent: 8 });
  if (q.comments.length < q.count) {
    y = paragraph(doc, y, `The newest ${q.comments.length} of ${q.count} comments.`, { color: COLOR_MUTED, size: 8 });
  }
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
