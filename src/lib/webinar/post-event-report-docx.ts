/**
 * The post-event report as a Word document (Nov 25, 2026; owner: the client wants to edit the PDF).
 * The same report, the same words (post-event-report-text.ts) and the same rules as the PDF: no
 * attendee named, comments only when asked. Built from paragraphs, headings and plain tables, so it
 * opens and edits cleanly in Word, Pages, LibreOffice and Google Docs. Every text passes through
 * sanitizeXmlText (docx-export.ts): one pasted control character must not stop Word opening the file.
 * SERVER ONLY (docx packs a zip with Node buffers).
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { sanitizeXmlText } from "@/lib/docx-export";
import { percentOf, type PostEventReport, type ReportBreakdown, type ReportSurveyQuestion } from "./post-event-report";
import type { ReportCompany } from "./post-event-report-pdf";
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
  REPORT_DOCUMENT_TITLE,
  reportWhenLine,
  surveyHeading,
} from "./post-event-report-text";

/** Half-points, as docx sizes runs: 21 is 10.5pt. */
const BODY = 21;
const SMALL = 17;
const MUTED = "6B7280";
const AMBER = "B45309";
const RULE = "D4D4D8";

type Block = Paragraph | Table;

function cell(text: string, opts: { bold?: boolean; right?: boolean; width: number }): TableCell {
  return new TableCell({
    width: { size: twips(opts.width), type: WidthType.DXA },
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text: clean(text), size: BODY, bold: opts.bold })],
      }),
    ],
  });
}

const BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

/**
 * The text width of docx's default page (A4, 1 inch margins), in twentieths of a point. Tables are
 * sized in it, fixed: a table sized in percentages collapsed to one letter a line in Pages and the
 * macOS preview (found on the first build, Nov 25, 2026).
 */
const TEXT_WIDTH = 11906 - 2 * 1440;
const twips = (share: number) => Math.round((TEXT_WIDTH * share) / 100);

function table(rows: TableRow[], shares: readonly number[]): Table {
  return new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: shares.map(twips),
    layout: TableLayoutType.FIXED,
    borders: BORDERS,
    rows,
  });
}

const clean = (text: string) => sanitizeXmlText(text);

function para(text: string, opts: { size?: number; color?: string; bold?: boolean; italics?: boolean; indent?: boolean } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    indent: opts.indent ? { left: 280 } : undefined,
    children: [new TextRun({ text: clean(text), size: opts.size ?? BODY, color: opts.color, bold: opts.bold, italics: opts.italics })],
  });
}

function heading(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 }, children: [new TextRun({ text: clean(text) })] });
}

function subheading(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: clean(text) })] });
}

/** A breakdown as a table: the label, the count, and its share of the total. */
function breakdownTable(rows: readonly ReportBreakdown[], total: number, firstColumn: string): Table {
  const header = new TableRow({
    tableHeader: true,
    children: [cell(firstColumn, { bold: true, width: 60 }), cell("Count", { bold: true, right: true, width: 20 }), cell("Share", { bold: true, right: true, width: 20 })],
  });
  const body = rows.map(
    (row) =>
      new TableRow({
        children: [
          cell(row.label, { width: 60 }),
          cell(String(row.count), { right: true, width: 20 }),
          cell(`${percentOf(row.count, total)}%`, { right: true, width: 20 }),
        ],
      }),
  );
  return table([header, ...body], [60, 20, 20]);
}

function glanceTable(r: PostEventReport): Table {
  return table(
    glanceTiles(r).map((t) => new TableRow({ children: [cell(t.label, { width: 60 }), cell(t.value, { bold: true, right: true, width: 40 })] })),
    [60, 40],
  );
}

function surveyQuestionBlocks(q: ReportSurveyQuestion, commentsIncluded: boolean): Block[] {
  const blocks: Block[] = [para(q.label, { bold: true })];
  if (q.type === "rating") {
    blocks.push(para(ratingLine(q.mean, q.count), { color: MUTED, size: SMALL }), breakdownTable(ratingRows(q.distribution), q.count, "Rating"));
    return blocks;
  }
  if (q.type === "choice") {
    blocks.push(breakdownTable(q.options, q.count, "Answer"));
    return blocks;
  }
  if (!commentsIncluded) return [...blocks, para(commentsLeftOutLine(q.count), { color: MUTED, size: SMALL })];
  if (q.comments.length === 0) return [...blocks, para("No comments.", { color: MUTED, size: SMALL })];
  for (const c of q.comments) blocks.push(para(`“${c}”`, { indent: true }));
  const shown = commentsShownNote(q.comments.length, q.count);
  if (shown) blocks.push(para(shown, { color: MUTED, size: SMALL }));
  return blocks;
}

function questionBlocks(r: PostEventReport): Block[] {
  const blocks: Block[] = [heading("Questions"), para(questionsLine(r))];
  r.questions.items.forEach((q, i) => {
    const tags = questionTags(q);
    blocks.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: clean(`${i + 1}. ${q.question}`), size: BODY }),
          ...(tags ? [new TextRun({ text: clean(`  (${tags})`), size: SMALL, color: MUTED })] : []),
        ],
      }),
    );
  });
  const listed = questionsListedNote(r);
  if (listed) blocks.push(para(listed, { color: MUTED, size: SMALL }));
  return blocks;
}

function surveyBlocks(r: PostEventReport): Block[] {
  if (r.surveys === null) return [];
  if (r.surveys.length === 0) return [heading("Survey results"), para("No survey answers yet.")];
  const blocks: Block[] = [heading("Survey results")];
  for (const s of r.surveys) {
    blocks.push(subheading(surveyHeading(s)));
    for (const q of s.questions) blocks.push(...surveyQuestionBlocks(q, r.commentsIncluded));
  }
  return blocks;
}

function reportBlocks(r: PostEventReport, company: ReportCompany): Block[] {
  const blocks: Block[] = [
    para(company.companyName || company.name, { color: MUTED, size: SMALL }),
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 60 }, children: [new TextRun({ text: clean(r.event.name) })] }),
    para(REPORT_DOCUMENT_TITLE, { bold: true }),
    para(reportWhenLine(r), { color: MUTED, size: SMALL }),
  ];
  if (r.event.status !== "ended") blocks.push(para(NOT_ENDED_NOTE, { color: AMBER, size: SMALL }));
  blocks.push(para(PRIVACY_NOTE, { color: MUTED, size: SMALL, italics: true }));

  blocks.push(heading("At a glance"), glanceTable(r));

  blocks.push(heading("Registrations"), para(registrationsLine(r)));
  if (r.registrations.byType.length) blocks.push(breakdownTable(r.registrations.byType, r.registrations.registered, "Registration type"));

  blocks.push(heading("Attendance"), para(attendanceLine(r)));
  if (r.attendance.archived) blocks.push(para(ARCHIVED_NOTE, { color: MUTED, size: SMALL }));
  if (r.attendance.devices.length) blocks.push(subheading("Watched on"), breakdownTable(r.attendance.devices, r.attendance.attended, "Device"));

  return [...blocks, ...questionBlocks(r), ...surveyBlocks(r)];
}

export async function generatePostEventReportDocx(report: PostEventReport, company: ReportCompany): Promise<Buffer> {
  const doc = new Document({
    title: clean(`${report.event.name}: ${REPORT_DOCUMENT_TITLE}`),
    sections: [{ properties: {}, children: reportBlocks(report, company) }],
  });
  return Packer.toBuffer(doc);
}
