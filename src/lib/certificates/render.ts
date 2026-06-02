/**
 * Certificate PDF renderer — v3 PDF-overlay model (2026-06-02).
 *
 * Architecture flip from v2: organizers upload a finished-design PDF from
 * their designer (banner, borders, signatures, footer logos all baked in).
 * We load it as the background canvas, then overlay positioned text boxes
 * containing token-substituted content. No more in-code composition.
 *
 * Reuses:
 *   - mergeBody() from template.ts for {{token}} substitution (unchanged
 *     across v2 → v3; the tokens are the same)
 *   - effectiveTemplate() merge of organizer-template-over-defaults
 *   - uploadCertificatePdf() in src/lib/storage.ts (storage path
 *     unchanged; the renderer output buffer is what changed shape).
 *
 * Throws away ~700 lines of v2 code (rosettes, watermark, seal, title
 * flourishes, drawHtmlBody, drawCenteredRuns, etc.) — that machinery
 * lives in git history (commit 6dae410..d8f5c02) if we ever need to
 * resurrect parts of it. speaker-agreement.ts still uses
 * parseHtmlToBlocks for its own use case; that import is gone here.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { apiLogger } from "@/lib/logger";
import { effectiveTemplate, mergeBody } from "./template";
import type {
  CertificateData,
  CertificateTextBox,
  CertificateFontName,
} from "./types";

/** Load + cache the background PDF bytes for a given URL. */
async function fetchBackgroundPdf(url: string): Promise<Buffer> {
  if (url.startsWith("/uploads/")) {
    // Local file — read from disk.
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    return readFile(join(process.cwd(), "public", url));
  }
  // Supabase / absolute URL — fetch.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch background PDF (HTTP ${res.status}): ${url}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/** Map our CertificateFontName to pdf-lib's StandardFonts enum value. */
function standardFontFor(name: CertificateFontName) {
  switch (name) {
    case "Helvetica":             return StandardFonts.Helvetica;
    case "Helvetica-Bold":        return StandardFonts.HelveticaBold;
    case "Helvetica-Oblique":     return StandardFonts.HelveticaOblique;
    case "Helvetica-BoldOblique": return StandardFonts.HelveticaBoldOblique;
    case "Times-Roman":           return StandardFonts.TimesRoman;
    case "Times-Bold":            return StandardFonts.TimesRomanBold;
    case "Times-Italic":          return StandardFonts.TimesRomanItalic;
    case "Times-BoldItalic":      return StandardFonts.TimesRomanBoldItalic;
    case "Courier":               return StandardFonts.Courier;
    case "Courier-Bold":          return StandardFonts.CourierBold;
    case "Courier-Oblique":       return StandardFonts.CourierOblique;
    case "Courier-BoldOblique":   return StandardFonts.CourierBoldOblique;
  }
}

/** Parse a 6-digit hex string into pdf-lib's rgb() color. Falls back to
 *  black on invalid input — better than throwing in the render path. */
function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/**
 * Render a single cert as PDF bytes. Pure function — no DB, no network
 * beyond the (cacheable) background PDF fetch. Same call signature as
 * v2 so the issue-worker, preview endpoint, and (eventual) reissue
 * path don't change.
 *
 * Empty-template handling: if no backgroundPdfUrl is configured, returns
 * a minimal placeholder PDF with an "Upload a background PDF" message
 * so the preview endpoint can show something useful during the editor
 * configuration phase.
 */
export async function renderCertificate(data: CertificateData): Promise<Buffer> {
  const tmpl = effectiveTemplate(data.type, data.template);

  // No background PDF configured → render a placeholder one-pager so
  // the preview shows "you need to upload a PDF" instead of failing.
  if (!tmpl.backgroundPdfUrl) {
    return renderPlaceholder(data);
  }

  // Load the background PDF.
  let bgBytes: Buffer;
  try {
    bgBytes = await fetchBackgroundPdf(tmpl.backgroundPdfUrl);
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "cert-renderer:bg-pdf-fetch-failed",
      url: tmpl.backgroundPdfUrl,
      hint: "Falling back to placeholder. Check storage provider config + URL validity.",
    });
    return renderPlaceholder(data);
  }

  // Open the bg PDF + grab page 1 (single-page support per v1 scope).
  const pdfDoc = await PDFDocument.load(bgBytes);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) {
    throw new Error("Background PDF has no pages");
  }
  const page = pages[0];
  const { height: pageHeight } = page.getSize();

  // Cache embedded fonts so we don't re-embed the same font for every box.
  const fontCache = new Map<CertificateFontName, PDFFont>();
  async function getFont(name: CertificateFontName): Promise<PDFFont> {
    const cached = fontCache.get(name);
    if (cached) return cached;
    const font = await pdfDoc.embedFont(standardFontFor(name));
    fontCache.set(name, font);
    return font;
  }

  // Paint each text box on top of the background.
  for (const box of tmpl.textBoxes ?? []) {
    await drawTextBox(box, pageHeight, getFont, data, page);
  }

  // Update PDF metadata so file managers / browsers display sensibly.
  pdfDoc.setTitle(`Certificate — ${data.recipient.fullName}`);
  pdfDoc.setAuthor(data.event.organizationName);
  pdfDoc.setSubject(`${data.type} for ${data.event.name}`);
  pdfDoc.setCreator("EA-SYS Certificate Renderer");

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

/**
 * Draw one text box on top of the bg PDF. Coordinate conversion: the
 * editor sends (x, y) in TOP-LEFT origin pixels (browser DOM convention),
 * and pdf-lib draws in BOTTOM-LEFT origin points. We convert by:
 *   pdfY = pageHeight - editorY - boxHeight + (boxHeight - fontAscent)
 * The "+ (boxHeight - fontAscent)" centers the text vertically inside
 * the box, matching what the canvas editor shows.
 *
 * Token substitution: mergeBody() does the regex replace on the box
 * content. Unknown tokens render as empty string + log a warn (caught
 * once per render, not per recipient — the templates are stable).
 */
async function drawTextBox(
  box: CertificateTextBox,
  pageHeight: number,
  getFont: (name: CertificateFontName) => Promise<PDFFont>,
  data: CertificateData,
  page: ReturnType<PDFDocument["getPages"]>[number],
) {
  const text = mergeBody(box.content, data);
  if (!text || text.trim().length === 0) return;

  const font = await getFont(box.font);
  const color = hexToRgb(box.color);
  const fontSize = box.size;
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const ascent = font.heightAtSize(fontSize, { descender: false });

  // Horizontal anchor — depends on alignment. The editor's (x, y) is the
  // top-left of the box. For "center" / "right" we shift the draw start
  // X accordingly so the text fits inside the box width.
  let drawX: number;
  switch (box.align) {
    case "left":
      drawX = box.x;
      break;
    case "right":
      drawX = box.x + box.width - textWidth;
      break;
    case "center":
    default:
      drawX = box.x + (box.width - textWidth) / 2;
      break;
  }

  // Vertical anchor: convert top-left editor Y to pdf-lib's bottom-left
  // baseline Y. Center text inside the box vertically.
  const drawY = pageHeight - box.y - (box.height - (box.height - ascent) / 2);

  page.drawText(text, {
    x: drawX,
    y: drawY,
    size: fontSize,
    font,
    color,
  });
}

/**
 * Placeholder PDF for events that haven't uploaded a background yet —
 * gives the preview endpoint something useful instead of an error page.
 * Plain Helvetica, A4 portrait, navy text on white.
 */
async function renderPlaceholder(data: CertificateData): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 portrait in points
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.1, 0.18, 0.35);
  const muted = rgb(0.35, 0.35, 0.4);

  page.drawText(`${data.type} certificate template`, {
    x: 60, y: 700,
    size: 18, font: fontBold, color: navy,
  });
  page.drawText("No background PDF uploaded yet.", {
    x: 60, y: 670,
    size: 13, font, color: muted,
  });

  const lines = [
    "Configure this cert type in the Template tab:",
    "  1. Upload your designer's finished cert PDF",
    "  2. Drag text boxes onto the canvas",
    "  3. Each box gets static text + {{tokens}} that resolve per recipient",
    "",
    "Tokens available:",
    "  {{recipientName}}            Dr. Sample Attendee",
    "  {{eventName}}                The event name",
    "  {{eventDateRange}}           5th - 7th December 2025",
    "  {{venueLine}}                at Conrad Dubai, UAE",
    "  {{accreditationBody}}        Dubai Health Authority (DHA)",
    "  {{accreditationReference}}   DHA-CPD-2026-0142",
    "  {{cmeHours}}                 18",
  ];
  let y = 620;
  for (const line of lines) {
    page.drawText(line, { x: 60, y, size: 11, font, color: muted });
    y -= 18;
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}
