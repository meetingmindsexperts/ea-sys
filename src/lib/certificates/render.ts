/**
 * Certificate PDF renderer — A4 portrait, asset-driven design.
 *
 * Architecture (2026-06-01 redesign, after CEO/MD reference review):
 * the organizer owns the visual identity by uploading event-specific
 * assets — banner image, signature image(s), footer logos, footer text
 * — and we compose them into a structured cert with merge-token body
 * text. We DON'T render borders, ornaments, watermarks, seals, or any
 * other "platform diploma" decorations; that fixed-style approach was
 * rejected in favor of letting each event express its own brand.
 *
 * Layout (top to bottom):
 *   1. Header image     — uploaded banner, fills top ~22% of page
 *   2. Title            — italic script "Certificate of Attendance"
 *                         flanked by curved navy flourishes
 *   3. Merged body      — line-per-line render of bodyTemplate with
 *                         tokens resolved (recipient name pulled out
 *                         and styled as the focal element)
 *   4. Signature row    — 1-N signatures side-by-side; each has an
 *                         optional image + name + label lines
 *   5. Footer logos     — 0-N labeled logos in a row
 *   6. Footer text      — optional plain copy under the logos
 *
 * Page background: plain white (per references — no parchment now).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { effectiveTemplate, mergeBody } from "./template";
import { parseHtmlToBlocks, type InlineRun } from "@/lib/speaker-agreement";
import type {
  CertificateData,
  CertificateSignature,
  CertificateFooterLogo,
} from "./types";

type PDFDoc = InstanceType<typeof PDFDocument>;

// A4 portrait dimensions (in pdfkit points).
const PAGE_W = 595;
const PAGE_H = 842;
const HEADER_BAND_HEIGHT = 200;   // top ~24% for uploaded banner
const SIDE_MARGIN = 48;
const INNER_WIDTH = PAGE_W - 2 * SIDE_MARGIN;

// Title block sits ~30pt below the header band; the recipient name +
// body text follow with the spacing rhythm baked into the layout below.
const TITLE_TOP_GAP = 30;
const TITLE_SIZE = 38;
const TITLE_FLOURISH_LEN = 80;
const TITLE_FLOURISH_GAP = 18;
const BODY_TOP_GAP = 30;
const RECIPIENT_SIZE = 30;
const BODY_SIZE = 12;
const SIGNATURE_LINE_WIDTH = 180;
const SIGNATURE_IMAGE_MAX_H = 50;
const FOOTER_LOGO_MAX_H = 50;

// ── Local-asset loader (banner / signature / footer-logo files) ─────────────

/**
 * Loads a local PNG/JPG asset by URL. Accepts our standard `/uploads/...`
 * URLs (served by `src/app/uploads/[...path]/route.ts` from
 * `public/uploads/`) and falls back to `null` if the asset is missing
 * or the URL isn't local. Never throws — a missing logo should produce
 * an empty slot, not a 500. Mirrors `src/lib/pdf/document-layout.ts
 * loadLocalLogo()` for consistency.
 */
function loadLocalAsset(url: string | null | undefined): Buffer | null {
  if (!url) return null;
  if (!url.startsWith("/uploads/") && !url.startsWith("/certificates/")) {
    apiLogger.warn({
      msg: "cert-renderer:asset-skipped-not-local",
      url,
      hint: "Only /uploads/... or /certificates/... paths can be embedded. " +
        "Upload the asset via the media library to get a usable URL.",
    });
    return null;
  }
  try {
    const absolutePath = join(process.cwd(), "public", url);
    if (!existsSync(absolutePath)) {
      apiLogger.warn({ msg: "cert-renderer:asset-missing", url, absolutePath });
      return null;
    }
    return readFileSync(absolutePath);
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "cert-renderer:asset-read-failed",
      url,
      hint: "File present but unreadable. PDF renders with empty slot.",
    });
    return null;
  }
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Render a certificate to a PDF buffer. Pure: no DB, no network. Same
 * function backs the preview endpoint AND the (Phase C) issue route.
 */
export async function renderCertificate(data: CertificateData): Promise<Buffer> {
  const tmpl = effectiveTemplate(data.type, data.template);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: {
      Title: titleForType(data, tmpl.titleText ?? ""),
      Author: data.event.organizationName,
      Subject: `Certificate for ${data.recipient.fullName} — ${data.event.name}`,
      Creator: "EA-SYS Certificate Renderer",
    },
  });

  const buffers: Buffer[] = [];
  doc.on("data", (chunk) => buffers.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  drawBackground(doc);
  const titleStartY = drawHeader(doc, tmpl.headerImage ?? null);
  const bodyStartY = drawTitle(doc, tmpl.titleText ?? "", tmpl.titleColor ?? "#1a2e5a", titleStartY);
  drawBody(doc, tmpl.bodyTemplate ?? "", data, bodyStartY);
  drawFooterRegion(doc, tmpl.signatures ?? [], tmpl.footerLogos ?? [], tmpl.footerText ?? "");

  doc.end();
  return done;
}

// ── Layout blocks ────────────────────────────────────────────────────────────

function drawBackground(doc: PDFDoc) {
  // Plain white page — matches the reference certs. The banner provides
  // top-of-page color; the body sits on clean white for legibility.
  doc.save().rect(0, 0, PAGE_W, PAGE_H).fill("#ffffff").restore();
}

/**
 * Draws the uploaded header banner across the top of the page. When
 * no banner is configured (default-template event), renders a thin
 * navy strip with the event name + dates so the cert still has top
 * branding even before the organizer uploads their asset.
 */
function drawHeader(doc: PDFDoc, headerImageUrl: string | null): number {
  const buffer = loadLocalAsset(headerImageUrl);
  if (buffer) {
    // Fill the top band — fit the banner image inside the header area
    // preserving aspect ratio. Designer-supplied banner is responsible
    // for its own aspect.
    doc.image(buffer, 0, 0, {
      fit: [PAGE_W, HEADER_BAND_HEIGHT],
      align: "center",
      valign: "center",
    });
    return HEADER_BAND_HEIGHT + TITLE_TOP_GAP;
  }
  // No banner configured — placeholder strip. Light navy gradient, just
  // enough to indicate "this is where the banner goes" without being
  // ugly enough to look broken.
  const grad = doc
    .linearGradient(0, 0, PAGE_W, 0)
    .stop(0, "#1a2e5a")
    .stop(1, "#2c4787");
  doc.save().rect(0, 0, PAGE_W, HEADER_BAND_HEIGHT).fill(grad).restore();
  doc
    .save()
    .fillColor("#ffffff")
    .font("Helvetica")
    .fontSize(11)
    .text(
      // ASCII-only placeholder — pdfkit's Helvetica uses WinAnsi encoding
      // which mangles Unicode arrows into garbage. Plain ">" stays safe.
      "Upload a header banner in Event Settings > Certificates > Template",
      0,
      HEADER_BAND_HEIGHT / 2 - 6,
      { align: "center", width: PAGE_W, lineBreak: false },
    )
    .restore();
  return HEADER_BAND_HEIGHT + TITLE_TOP_GAP;
}

/**
 * Title — italic-script style heading. We use pdfkit's Times-BoldItalic
 * as a script approximation for v1 (no TTF embed). The flanking curved
 * flourishes are the visual touch from both references: short navy
 * curves that bracket the title.
 */
function drawTitle(doc: PDFDoc, titleText: string, color: string, y: number): number {
  if (!titleText) titleText = "Certificate";
  doc.font("Times-BoldItalic").fontSize(TITLE_SIZE).fillColor(color);
  const titleWidth = doc.widthOfString(titleText);
  const titleX = (PAGE_W - titleWidth) / 2;
  const baselineY = y + TITLE_SIZE * 0.7;

  // Curved flourishes on each side — quarter-arc-style with a small
  // inward tick at the inner end. Matches the references' bracket lines.
  doc.save().strokeColor(color).lineWidth(1.2);
  // Left side
  const lStart = titleX - TITLE_FLOURISH_GAP - TITLE_FLOURISH_LEN;
  const lEnd = titleX - TITLE_FLOURISH_GAP;
  doc.moveTo(lStart, baselineY).lineTo(lEnd, baselineY).stroke();
  // Small upward hook at the inner end of the left line
  doc.moveTo(lEnd, baselineY).lineTo(lEnd - 4, baselineY - 6).stroke();
  doc.moveTo(lStart, baselineY).lineTo(lStart, baselineY - 6).stroke();
  // Right side (mirrored)
  const rStart = titleX + titleWidth + TITLE_FLOURISH_GAP;
  const rEnd = rStart + TITLE_FLOURISH_LEN;
  doc.moveTo(rStart, baselineY).lineTo(rEnd, baselineY).stroke();
  doc.moveTo(rStart, baselineY).lineTo(rStart + 4, baselineY - 6).stroke();
  doc.moveTo(rEnd, baselineY).lineTo(rEnd, baselineY - 6).stroke();
  doc.restore();

  // Title text on top of the flourishes
  doc.fillColor(color).text(titleText, 0, y, {
    align: "center",
    width: PAGE_W,
    lineBreak: false,
  });

  return y + TITLE_SIZE + BODY_TOP_GAP;
}

/**
 * Body block — renders the WYSIWYG body template as a sequence of
 * centered paragraphs + headings with inline bold / italic / underline
 * runs. Replaces the previous line-by-line plain-text rendering with
 * content-match heuristics (which were fragile — relied on lines
 * equalling recipient.fullName etc).
 *
 * Pipeline:
 *   1. mergeBody() substitutes {{tokens}} in the HTML string
 *   2. parseHtmlToBlocks() (reused from speaker-agreement.ts) turns the
 *      merged HTML into a flat list of Block directives with InlineRun
 *      arrays carrying per-run formatting
 *   3. We render each block centered with size hierarchy:
 *        <h1> ~32pt, <h2> ~26pt (recipient name), <h3> ~16pt navy bold
 *        (event name), <p> ~12pt body
 *      Lists / tables / callouts from the parser are ignored — those
 *      shapes aren't sensible on a centered cert body.
 */
function drawBody(doc: PDFDoc, bodyTemplate: string, data: CertificateData, y: number) {
  const mergedHtml = mergeBody(bodyTemplate, data);
  const blocks = parseHtmlToBlocks(mergedHtml);

  let cursor = y;
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      cursor = drawCenteredRuns(doc, block.runs, cursor, {
        size: BODY_SIZE,
        color: "#333333",
      });
      cursor += 4;
    } else if (block.kind === "heading") {
      // H1 → largest; H2 → recipient-sized; H3 → bold-navy emphasis.
      // H4+ fall back to H3 styling.
      const styleByLevel = headingStyle(block.level);
      cursor = drawCenteredRuns(doc, block.runs, cursor, styleByLevel);
      cursor += 6;
    } else if (block.kind === "list-item") {
      // Lists render as plain centered paragraphs prefixed with a bullet;
      // ordered lists prefix with the index. Center alignment makes
      // numbered/bulleted lists feel odd on a cert but the user asked
      // for the bullet so we honor it minimally.
      const prefix = block.ordered ? `${block.index}. ` : "• ";
      const prefixed: InlineRun[] = [
        { text: prefix, bold: false, italic: false, underline: false },
        ...block.runs,
      ];
      cursor = drawCenteredRuns(doc, prefixed, cursor, {
        size: BODY_SIZE,
        color: "#333333",
      });
      cursor += 4;
    } else if (block.kind === "rule") {
      // <hr> renders as a thin centered rule.
      const ruleW = INNER_WIDTH * 0.4;
      const ruleX = (PAGE_W - ruleW) / 2;
      doc
        .save()
        .strokeColor("#999999")
        .lineWidth(0.5)
        .moveTo(ruleX, cursor + 4)
        .lineTo(ruleX + ruleW, cursor + 4)
        .stroke()
        .restore();
      cursor += 12;
    }
    // tables + callouts intentionally ignored — they don't fit the
    // centered single-column cert layout. If a user pastes one in
    // they're silently dropped (not great UX; future polish if needed).
  }
}

/** Heading size + color by level — fixed scale. */
function headingStyle(level: number): { size: number; color: string; bold?: boolean } {
  switch (level) {
    case 1:
      return { size: 32, color: "#111111" };
    case 2:
      return { size: RECIPIENT_SIZE, color: "#111111" }; // recipient-sized
    case 3:
      return { size: BODY_SIZE + 4, color: "#1a2e5a" }; // navy emphasis
    default:
      return { size: BODY_SIZE + 2, color: "#1a2e5a" };
  }
}

/**
 * Render a sequence of inline runs centered on the page, with bold /
 * italic / underline applied per run via font swapping. Returns the
 * bottom Y after rendering so the caller can advance its cursor.
 *
 * pdfkit doesn't natively support "mixed-formatting wrapped paragraph"
 * rendering — the closest API is `text(..., { continued: true })` which
 * lets you chain runs on a single line but breaks center alignment when
 * the line wraps. So we measure each run's width and lay out manually:
 *   - Group runs into visual lines that fit within INNER_WIDTH
 *   - For each line, compute total width + center-X start
 *   - Render each run with `continued: true` until the last
 */
function drawCenteredRuns(
  doc: PDFDoc,
  runs: InlineRun[],
  y: number,
  style: { size: number; color: string },
): number {
  if (runs.length === 0) return y + style.size * 1.2;

  // Greedy line wrap: walk through runs word by word, measure as we
  // go, break to a new line when adding the next word would exceed
  // INNER_WIDTH.
  type LinedRun = { text: string; bold: boolean; italic: boolean; underline: boolean };
  const lines: LinedRun[][] = [[]];
  for (const run of runs) {
    const words = run.text.split(/(\s+)/); // keep whitespace tokens
    for (const word of words) {
      if (word === "") continue;
      const font = pickFont(run.bold, run.italic);
      doc.font(font).fontSize(style.size);
      const wordWidth = doc.widthOfString(word);
      const currentLine = lines[lines.length - 1];
      const currentLineWidth = currentLine.reduce((sum, r) => {
        doc.font(pickFont(r.bold, r.italic)).fontSize(style.size);
        return sum + doc.widthOfString(r.text);
      }, 0);
      if (currentLineWidth + wordWidth > INNER_WIDTH && currentLine.length > 0) {
        // Trim trailing whitespace before line break.
        while (currentLine.length > 0 && /^\s+$/.test(currentLine[currentLine.length - 1].text)) {
          currentLine.pop();
        }
        lines.push([]);
      }
      lines[lines.length - 1].push({
        text: word,
        bold: run.bold,
        italic: run.italic,
        underline: run.underline,
      });
    }
  }

  let cursor = y;
  for (const line of lines) {
    if (line.length === 0) continue;
    // Compute total line width to find the centered starting X.
    let totalW = 0;
    for (const r of line) {
      doc.font(pickFont(r.bold, r.italic)).fontSize(style.size);
      totalW += doc.widthOfString(r.text);
    }
    let x = (PAGE_W - totalW) / 2;
    const lineY = cursor;
    for (const r of line) {
      doc
        .font(pickFont(r.bold, r.italic))
        .fontSize(style.size)
        .fillColor(style.color);
      doc.text(r.text, x, lineY, { lineBreak: false });
      const w = doc.widthOfString(r.text);
      if (r.underline) {
        doc
          .save()
          .strokeColor(style.color)
          .lineWidth(0.5)
          .moveTo(x, lineY + style.size * 0.95)
          .lineTo(x + w, lineY + style.size * 0.95)
          .stroke()
          .restore();
      }
      x += w;
    }
    cursor += style.size * 1.2;
  }
  return cursor;
}

/** Pick a pdfkit built-in font name for a run's bold/italic combo. */
function pickFont(bold: boolean, italic: boolean): string {
  if (bold && italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/**
 * Footer region — anchored to the bottom of the page so it sits at a
 * stable position regardless of body length. Contains (top→bottom):
 *   - Signature row (1..N signatures side-by-side)
 *   - Footer logos row (0..N logos with optional labels above each)
 *   - Footer text (optional plain copy)
 */
function drawFooterRegion(
  doc: PDFDoc,
  signatures: CertificateSignature[],
  footerLogos: CertificateFooterLogo[],
  footerText: string,
) {
  // Compute total footer height from the bottom up.
  const sigBlockHeight = signatures.length > 0 ? SIGNATURE_IMAGE_MAX_H + 50 : 0;
  const logoBlockHeight = footerLogos.length > 0 ? FOOTER_LOGO_MAX_H + 22 : 0;
  const textBlockHeight = footerText ? 20 : 0;
  const gap1 = signatures.length > 0 && footerLogos.length > 0 ? 30 : 0;
  const gap2 = (signatures.length > 0 || footerLogos.length > 0) && footerText ? 14 : 0;

  const totalFooterHeight = sigBlockHeight + gap1 + logoBlockHeight + gap2 + textBlockHeight;
  const footerTop = PAGE_H - SIDE_MARGIN - totalFooterHeight;

  let cursor = footerTop;
  if (signatures.length > 0) {
    drawSignatureRow(doc, signatures, cursor);
    cursor += sigBlockHeight + gap1;
  }
  if (footerLogos.length > 0) {
    drawFooterLogoRow(doc, footerLogos, cursor);
    cursor += logoBlockHeight + gap2;
  }
  if (footerText) {
    // Footer text is HTML (Tiptap output) — render it via the same
    // inline-runs pipeline as the body so bold/italic/links round-trip.
    // Sized smaller than the body (9pt) and muted.
    const blocks = parseHtmlToBlocks(footerText);
    let footerCursor = cursor;
    for (const block of blocks) {
      const runs = "runs" in block ? block.runs : null;
      if (!runs || runs.length === 0) continue;
      footerCursor = drawCenteredRuns(doc, runs, footerCursor, {
        size: 9,
        color: "#666666",
      });
      footerCursor += 2;
    }
  }
}

function drawSignatureRow(
  doc: PDFDoc,
  signatures: CertificateSignature[],
  topY: number,
) {
  const count = signatures.length;
  // Each signature gets an equal slice of the inner width, padded.
  const slice = INNER_WIDTH / count;
  signatures.forEach((sig, idx) => {
    const cx = SIDE_MARGIN + slice * idx + slice / 2;
    // Signature image (if uploaded) sits above the line, otherwise we
    // just draw the line + label.
    const sigBuffer = loadLocalAsset(sig.image ?? null);
    const lineY = topY + SIGNATURE_IMAGE_MAX_H + 8;
    if (sigBuffer) {
      // Fit signature inside [SIGNATURE_LINE_WIDTH, SIGNATURE_IMAGE_MAX_H]
      // bounding box, centered horizontally on cx, anchored at lineY top.
      doc.image(sigBuffer, cx - SIGNATURE_LINE_WIDTH / 2, topY, {
        fit: [SIGNATURE_LINE_WIDTH, SIGNATURE_IMAGE_MAX_H],
        align: "center",
        valign: "bottom",
      });
    }
    // Signature line
    doc
      .save()
      .strokeColor("#1a2e5a")
      .lineWidth(0.8)
      .moveTo(cx - SIGNATURE_LINE_WIDTH / 2, lineY)
      .lineTo(cx + SIGNATURE_LINE_WIDTH / 2, lineY)
      .stroke()
      .restore();
    // Name (bold) below the line
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#111111")
      .text(sig.name, cx - SIGNATURE_LINE_WIDTH / 2, lineY + 6, {
        width: SIGNATURE_LINE_WIDTH,
        align: "center",
        lineBreak: false,
      });
    // Label lines (smaller, muted)
    let labelY = lineY + 22;
    for (const line of sig.lines.slice(0, 4)) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#555555")
        .text(line, cx - SIGNATURE_LINE_WIDTH / 2, labelY, {
          width: SIGNATURE_LINE_WIDTH,
          align: "center",
          lineBreak: false,
        });
      labelY += 11;
    }
  });
}

function drawFooterLogoRow(
  doc: PDFDoc,
  logos: CertificateFooterLogo[],
  topY: number,
) {
  const count = logos.length;
  const slice = INNER_WIDTH / count;
  logos.forEach((logo, idx) => {
    const cx = SIDE_MARGIN + slice * idx + slice / 2;
    const cellW = Math.min(slice * 0.8, 140);

    // Label (optional) above the logo
    if (logo.label) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#666666")
        .text(logo.label, cx - cellW / 2, topY, {
          width: cellW,
          align: "center",
          lineBreak: false,
        });
    }
    const imgTop = logo.label ? topY + 14 : topY;
    const imgH = logo.label ? FOOTER_LOGO_MAX_H - 4 : FOOTER_LOGO_MAX_H;
    const buffer = loadLocalAsset(logo.image);
    if (buffer) {
      doc.image(buffer, cx - cellW / 2, imgTop, {
        fit: [cellW, imgH],
        align: "center",
        valign: "center",
      });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function titleForType(data: CertificateData, titleText: string): string {
  const t = titleText || "Certificate";
  return `${t} — ${data.recipient.fullName}`;
}
