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
const BODY_LINE_HEIGHT = 22;
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
 * Body block — render each line of the merged body template. Lines that
 * look like "the recipient name" (token resolution made them equal to
 * data.recipient.fullName) get rendered larger + in serif for emphasis.
 * Everything else renders as plain Helvetica.
 */
function drawBody(doc: PDFDoc, bodyTemplate: string, data: CertificateData, y: number) {
  const merged = mergeBody(bodyTemplate, data);
  const lines = merged.split("\n");
  const recipientName = data.recipient.fullName;

  let cursor = y;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      cursor += BODY_LINE_HEIGHT * 0.5;
      continue;
    }
    // Heuristic: if this line is the recipient name (post-merge),
    // render it large + bold-serif as the visual focus.
    if (line === recipientName) {
      doc
        .font("Times-Bold")
        .fontSize(RECIPIENT_SIZE)
        .fillColor("#111111")
        .text(line, SIDE_MARGIN, cursor, {
          align: "center",
          width: INNER_WIDTH,
          lineBreak: false,
        });
      cursor += RECIPIENT_SIZE + 8;
      continue;
    }
    // Heuristic: if this line contains the event name (and isn't just
    // the recipient), render bold to highlight it. Mirrors the
    // references' bold event-name treatment.
    const isEventName = line === data.event.name;
    if (isEventName) {
      doc
        .font("Helvetica-Bold")
        .fontSize(BODY_SIZE + 4)
        .fillColor("#1a2e5a");
      const wrapped = doc.heightOfString(line, {
        width: INNER_WIDTH,
        align: "center",
      });
      doc.text(line, SIDE_MARGIN, cursor, {
        align: "center",
        width: INNER_WIDTH,
        lineBreak: true,
      });
      cursor += wrapped + 4;
      continue;
    }
    // Plain body line
    doc.font("Helvetica").fontSize(BODY_SIZE).fillColor("#333333");
    const wrapped = doc.heightOfString(line, {
      width: INNER_WIDTH,
      align: "center",
    });
    doc.text(line, SIDE_MARGIN, cursor, {
      align: "center",
      width: INNER_WIDTH,
      lineBreak: true,
    });
    cursor += wrapped + 4;
  }
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
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#666666")
      .text(footerText, SIDE_MARGIN, cursor, {
        align: "center",
        width: INNER_WIDTH,
        lineBreak: true,
      });
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
