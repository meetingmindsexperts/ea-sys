import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/**
 * Generic "a list of entries, one below another" Word document builder.
 *
 * Deliberately domain-free: it knows about headings, label/value lines and a
 * body, and nothing about abstracts or session proposals. The two mappers in
 * [submission-docx-export.ts](./submission-docx-export.ts) turn rows into this
 * shape, so the abstracts document and the session-proposals document share ONE
 * layout and cannot drift apart the way two hand-built documents would.
 *
 * Text is passed to `docx` as data (TextRun children), never assembled as
 * markup, so an `&`, `<`, `>` or a quote in an organiser-authored title or in a
 * submitter's body lands verbatim in Word rather than corrupting the XML.
 */

/**
 * Strip what XML 1.0 forbids, and turn Word's own break characters into newlines.
 *
 * FOUND ON LIVE DATA (Sep 10, 2026): one abstract title on Middle East Heart
 * Failure 2027 carries a VERTICAL TAB (U+000B) where the author pressed
 * Shift+Enter in Word before pasting into the submission form. XML 1.0 admits
 * only #x9, #xA, #xD and #x20 upward, so `docx` wrote that byte straight into
 * `word/document.xml` and Word then refused to open the file — ONE bad title
 * silently broke the export of all four abstracts. A submitter pasting from
 * Word is the normal case, not the edge case, so the guard belongs here, at the
 * one point every string passes through, rather than at each call site.
 *
 * U+000B (vertical tab) and U+000C (form feed) MEAN a line break, so they
 * become one; everything else illegal is dropped rather than substituted, so a
 * stray byte leaves no visible mark in a document an organiser hands out.
 */
export function sanitizeXmlText(value: string): string {
  return (
    value
      // Word's in-paragraph break and page break both read as a new line.
      .replace(/[\u000B\u000C]/g, "\n")
      // Remaining C0 controls (XML 1.0 allows only tab, newline, carriage return).
      .replace(/[\u0000-\u0008\u000E-\u001F]/g, "")
      // Unpaired surrogates and the two permanently-unassigned code points. The
      // HIGH half must be matched as [\uD800-\uDBFF], not the whole surrogate
      // range: matching the whole range here eats the trailing half of a VALID
      // pair, which deletes every emoji (caught by the emoji test below).
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      .replace(/[\uFFFE\uFFFF]/g, "")
  );
}

/** A heading or a label/value line is one line: breaks collapse to a space. */
function singleLine(value: string): string {
  return sanitizeXmlText(value).replace(/\s*\n\s*/g, " ").trim();
}

export interface DocxField {
  label: string;
  value: string;
}

export interface DocxEntry {
  /** The line that names the entry, e.g. "A-007  Effect of X on Y". */
  heading: string;
  /** Label/value lines under the heading. Empty values are dropped. */
  fields: DocxField[];
  /** Free text. Blank lines are collapsed; each remaining line is a paragraph. */
  body: string;
}

export interface BuildEntriesDocxInput {
  /** Document title, e.g. "Middle East Heart Failure 2027 — Abstracts". */
  title: string;
  /** One muted line under the title, e.g. "14 abstracts · Exported 10 September 2026". */
  subtitle?: string;
  entries: DocxEntry[];
}

/** Half-points: `docx` sizes runs in half-points, so 22 renders as 11pt. */
const BODY_SIZE = 22;
const LABEL_SIZE = 22;
const SUBTITLE_SIZE = 18;

/**
 * A field renders only when it has a value. A bare "Theme:" with nothing after
 * it reads as a rendering fault rather than as "this abstract has no theme",
 * which is the same rule the certificate starter applies to its empty labels.
 */
function fieldParagraphs(fields: DocxField[]): Paragraph[] {
  return fields
    .filter((f) => f.value.trim().length > 0)
    .map(
      (f) =>
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({ text: `${singleLine(f.label)}: `, bold: true, size: LABEL_SIZE }),
            new TextRun({ text: singleLine(f.value), size: LABEL_SIZE }),
          ],
        }),
    );
}

/**
 * Split free text into paragraphs. Blank lines are dropped rather than rendered
 * as empty paragraphs, so a body typed with double line breaks does not open a
 * gap on every break; the paragraph spacing below supplies the separation.
 */
export function bodyParagraphs(body: string): Paragraph[] {
  return sanitizeXmlText(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        new Paragraph({
          spacing: { before: 60, after: 60 },
          children: [new TextRun({ text: line, size: BODY_SIZE })],
        }),
    );
}

/**
 * The separator between entries: an empty paragraph carrying a bottom border,
 * which is how a horizontal rule is expressed in WordprocessingML. Omitted
 * after the final entry so the document does not end on a dangling line.
 */
function separatorParagraph(): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "D4D4D8", space: 1 },
    },
    children: [],
  });
}

function entryParagraphs(entry: DocxEntry, isLast: boolean): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 120, after: 100 },
      children: [new TextRun({ text: singleLine(entry.heading) })],
    }),
    ...fieldParagraphs(entry.fields),
    ...bodyParagraphs(entry.body),
  ];

  if (!isLast) paragraphs.push(separatorParagraph());

  return paragraphs;
}

/**
 * Build the .docx bytes. Async because `docx` packs the zip asynchronously.
 *
 * Uses only paragraphs, runs, a heading style and a paragraph border — the
 * oldest and most widely supported parts of the format — so the output opens
 * in Word, Pages, LibreOffice and Google Docs without a compatibility shim.
 */
export async function buildEntriesDocx(input: BuildEntriesDocxInput): Promise<Buffer> {
  const header: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      spacing: { after: input.subtitle ? 40 : 200 },
      children: [new TextRun({ text: singleLine(input.title) })],
    }),
  ];

  if (input.subtitle) {
    header.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: singleLine(input.subtitle), size: SUBTITLE_SIZE, color: "6B7280" }),
        ],
      }),
    );
  }

  const body =
    input.entries.length > 0
      ? input.entries.flatMap((entry, i) =>
          entryParagraphs(entry, i === input.entries.length - 1),
        )
      : [
          new Paragraph({
            children: [new TextRun({ text: "No entries.", size: BODY_SIZE, italics: true })],
          }),
        ];

  const doc = new Document({
    sections: [{ properties: {}, children: [...header, ...body] }],
  });

  return Packer.toBuffer(doc);
}

/** What both export routes send back, so the two responses cannot disagree. */
export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
