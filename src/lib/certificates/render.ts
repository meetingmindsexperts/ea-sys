/**
 * Certificate PDF renderer — pdfkit-based, A4 landscape.
 *
 * Phase A baseline + Phase B first design pass (2026-06-01).
 *
 * One renderCertificate(data) entry point. Dispatches per CertificateType
 * to type-specific copy + the optional CME hours + accreditor block.
 * Visual decisions all live in tokens.ts so further design iteration
 * doesn't touch this file.
 *
 * Why pdfkit directly (not HTML→PDF): a certificate is a fixed precise
 * layout, not flowing content. Direct pdfkit gives us exact coordinates
 * + no surprises from CSS-to-PDF translation. The HTML-template approach
 * the speaker-agreement renderer uses is right for prose-heavy variable
 * layouts; certs are the opposite shape.
 *
 * MeetingMindsExperts logo is loaded once at module init from
 * public/certificates/mme-logo.png and embedded in every cert (centered
 * above the title). Missing-asset case fails gracefully — cert still
 * renders, just without the logo crown. Logs a warn so the absence is
 * visible in /logs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { CERT_TOKENS } from "./tokens";
import { apiLogger } from "@/lib/logger";
import type { CertificateData, AccreditationEntry } from "./types";

type PDFDoc = InstanceType<typeof PDFDocument>;

const { layout, colors, fonts, sizes, spacing } = CERT_TOKENS;

// Load logo once at module init — synchronous read is fine here, this
// runs at first import, not per request. Missing asset = cert renders
// without logo, structured warn so the absence is debuggable.
const MME_LOGO_BUFFER: Buffer | null = (() => {
  try {
    return readFileSync(join(process.cwd(), "public", "certificates", "mme-logo.png"));
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "cert-renderer:logo-missing",
      path: "public/certificates/mme-logo.png",
      hint: "Cert will render with empty logo slot. Copy the MME brand logo to that path on the EC2 host (or commit to the repo) to restore.",
    });
    return null;
  }
})();

/**
 * Render a certificate to a PDF buffer. Pure: no I/O beyond the in-memory
 * buffer, no DB, no network. Safe to call from the preview endpoint, the
 * issue route, and a future reprint route — same code path, same output.
 */
export async function renderCertificate(data: CertificateData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    // No `layout` field — A4 defaults to portrait (the format both
    // CEO/MD design references showed). Was landscape in v1; switched
    // 2026-06-01 Phase B round 3.
    // Document margins set to 0 — we manage layout absolutely via the
    // tokens, and pdfkit's auto-pagination triggers when text crosses
    // `pageHeight - bottomMargin`. Setting margins to 0 means pdfkit
    // never paginates the cert — exactly what we want for a single-page
    // certificate. Belt-and-suspenders alongside `lineBreak: false`
    // on every text() call.
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: {
      Title: titleForType(data),
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

  // Draw order is intentional — deepest layer first:
  //   1. Cream gradient background (full page)
  //   2. White header + footer bands (top + bottom zones for logo + signatures)
  //   3. Watermark MME logo (centered in cream middle area only)
  //   4. Triple border + rosette corners (on top of bands so the cert frame
  //      runs continuously around the page)
  //   5. Content blocks (logo, title, recipient, event, CME, footer)
  drawBackground(doc);
  // Header/footer white bands removed 2026-06-01 — the MME logo is now
  // transparent (alpha-channel PNG, white background stripped), so it
  // composites cleanly on the cream parchment and the band workaround
  // is no longer needed. The drawHeaderAndFooterBands helper is kept
  // in case we ever want letterhead zoning back.
  drawWatermark(doc);
  drawBorder(doc);
  const logoBottomY = drawLogo(doc);
  drawTopBand(doc, logoBottomY);
  const titleSubBottomY = drawTitleBlock(doc, data, logoBottomY + spacing.logoToTopBand + 10);
  const recipientBottomY = drawRecipientBlock(doc, titleSubBottomY, data);
  const eventBottomY = drawEventBlock(doc, data, recipientBottomY);
  if (data.type === "CME") {
    drawCmeBlock(doc, data, eventBottomY);
  }
  drawFooter(doc, data);

  doc.end();
  return done;
}

// ── Block renderers ──────────────────────────────────────────────────────────

/**
 * Cream/parchment background fill, full page. Single change that flipped
 * the cert from "form" to "diploma" — Phase B iteration round 2. Subtle
 * top-to-bottom gradient adds depth without distracting from content.
 */
function drawBackground(doc: PDFDoc) {
  // pdfkit supports linear gradients via `linearGradient(x1,y1,x2,y2).stop()`.
  // Vertical gradient (top to bottom) gives the "page sat in the sun a
  // while" parchment feel that a flat fill can't.
  const grad = doc
    .linearGradient(0, 0, 0, layout.height)
    .stop(0, colors.bgTop)
    .stop(1, colors.bgBottom);
  doc.save().rect(0, 0, layout.width, layout.height).fill(grad).restore();
}

/**
 * Large faint MME logo behind the content as a watermark/seal. Centered
 * in the CREAM MIDDLE AREA only — drawn after the white bands so it
 * doesn't render over the white zones (where it'd be invisible anyway,
 * and where the bright logo would be needed for crispness).
 */
function drawWatermark(doc: PDFDoc) {
  if (!MME_LOGO_BUFFER) return;
  const creamTop = layout.borderInnerInset + layout.headerBandHeight;
  const creamBottom = layout.height - layout.borderInnerInset - layout.footerBandHeight;
  const creamHeight = creamBottom - creamTop;
  const innerW = layout.width - 2 * layout.borderInnerInset;
  // Fit the watermark inside a centered box ~70% of the cream area's
  // smaller dimension — large enough to feel like a seal, small enough
  // not to overpower.
  const wmBox = Math.min(innerW, creamHeight) * 0.7;
  const wmCenterY = (creamTop + creamBottom) / 2;
  doc.save();
  doc.opacity(colors.watermarkOpacity);
  doc.image(MME_LOGO_BUFFER, (layout.width - wmBox) / 2, wmCenterY - wmBox / 2, {
    fit: [wmBox, wmBox],
    align: "center",
  });
  doc.restore();
}

/**
 * Render center-aligned text with width-clamping + automatic wrapping
 * + returns the bottom Y so the caller can advance its cursor. This is
 * the safe path for ANY variable-length user-supplied text — recipient
 * name, affiliation, event name, venue, poster abstract title. With
 * `lineBreak: true`, pdfkit wraps text inside the width constraint
 * instead of overflowing past the page border (the bug caught in
 * CEO/MD review when a long poster abstract title overflowed).
 *
 * Pagination prevented by the document-level `margins: 0` + the
 * inner-content-width clamping ensuring text never reaches the bottom.
 */
function drawWrappedCentered(
  doc: PDFDoc,
  text: string,
  y: number,
  options: {
    font: string;
    size: number;
    color: string;
    characterSpacing?: number;
    width?: number;
  },
): number {
  const width = options.width ?? layout.innerContentWidth;
  const x = (layout.width - width) / 2;
  doc.font(options.font).fontSize(options.size).fillColor(options.color);
  const measureOpts = {
    width,
    align: "center" as const,
    characterSpacing: options.characterSpacing,
  };
  const height = doc.heightOfString(text, measureOpts);
  doc.text(text, x, y, { ...measureOpts, lineBreak: true });
  return y + height;
}

/**
 * Triple-line border (navy outer thick, pale-gold middle hairline, deeper
 * gold inner hairline) + rosette ornaments at each inner corner. The
 * triple line is the convention for "this is a real diploma" — single line
 * looks like a form, triple line is unmistakably ceremonial.
 */
function drawBorder(doc: PDFDoc) {
  doc.save();

  // Outer thick navy frame.
  doc
    .lineWidth(layout.borderStrokeOuter)
    .strokeColor(colors.borderOuter)
    .rect(
      layout.borderOuterInset,
      layout.borderOuterInset,
      layout.width - 2 * layout.borderOuterInset,
      layout.height - 2 * layout.borderOuterInset,
    )
    .stroke();

  // Middle pale-gold hairline at the midpoint between outer and inner.
  // This is the "third line" that does most of the visual work for the
  // diploma feel.
  const midInset = (layout.borderOuterInset + layout.borderInnerInset) / 2;
  doc
    .lineWidth(0.3)
    .strokeColor(colors.borderMid)
    .rect(
      midInset,
      midInset,
      layout.width - 2 * midInset,
      layout.height - 2 * midInset,
    )
    .stroke();

  // Inner thin deeper-gold frame.
  doc
    .lineWidth(layout.borderStrokeInner)
    .strokeColor(colors.borderInner)
    .rect(
      layout.borderInnerInset,
      layout.borderInnerInset,
      layout.width - 2 * layout.borderInnerInset,
      layout.height - 2 * layout.borderInnerInset,
    )
    .stroke();

  // Corner rosettes — central filled circle + 4 small petals around it.
  // Replaces the v1 single-diamond corner ornament. Each rosette is
  // small but visually intricate; together they make the corners feel
  // engraved rather than ruled.
  const inset = layout.borderInnerInset;
  const corners: Array<[number, number]> = [
    [inset, inset],
    [layout.width - inset, inset],
    [layout.width - inset, layout.height - inset],
    [inset, layout.height - inset],
  ];
  for (const [cx, cy] of corners) {
    drawRosette(doc, cx, cy);
  }

  doc.restore();
}

/**
 * Small ornate corner ornament — central deeper-gold circle with 4
 * lighter-gold petal circles arranged at the cardinal points. Easy to
 * read at full size, evokes engraved cert flourishes without needing
 * actual filigree (which would require custom paths or a vector asset).
 */
function drawRosette(doc: PDFDoc, cx: number, cy: number) {
  const petalRadius = 2.2;
  const petalDistance = 4.5;
  const centerRadius = 2.6;
  doc.save();

  // Petals first (lighter gold) so the center sits on top.
  doc.fillColor(colors.cornerOrnamentPetal);
  doc.circle(cx, cy - petalDistance, petalRadius).fill();
  doc.circle(cx + petalDistance, cy, petalRadius).fill();
  doc.circle(cx, cy + petalDistance, petalRadius).fill();
  doc.circle(cx - petalDistance, cy, petalRadius).fill();

  // Center disc (deeper gold).
  doc.fillColor(colors.cornerOrnament).circle(cx, cy, centerRadius).fill();

  doc.restore();
}

/**
 * Thin decorative band under the logo — short horizontal rule with a
 * small diamond ornament at its midpoint. Visually closes the top
 * region of the cert before the title. Same pattern as the
 * recipient-name divider but smaller; deliberate consistency.
 */
function drawTopBand(doc: PDFDoc, logoBottomY: number) {
  const cx = layout.width / 2;
  const bandY = logoBottomY + 8;
  const lineW = 80;
  const ornament = 3;
  doc
    .save()
    .strokeColor(colors.dividerOrnament)
    .fillColor(colors.dividerOrnament)
    .lineWidth(0.6)
    .moveTo(cx - lineW, bandY)
    .lineTo(cx - ornament - 2, bandY)
    .stroke()
    .moveTo(cx + ornament + 2, bandY)
    .lineTo(cx + lineW, bandY)
    .stroke()
    .moveTo(cx, bandY - ornament)
    .lineTo(cx + ornament, bandY)
    .lineTo(cx, bandY + ornament)
    .lineTo(cx - ornament, bandY)
    .closePath()
    .fill()
    .restore();
}

/** Returns the Y coordinate immediately below the logo block. */
function drawLogo(doc: PDFDoc): number {
  const startY = layout.borderInnerInset + spacing.logoTopFromMargin;
  if (!MME_LOGO_BUFFER) {
    // No logo → just reserve no vertical space, title flows up.
    return startY;
  }
  // Use pdfkit's `fit: [w, h]` + `align: "center"` to place the logo
  // inside a bounding box bounded horizontally by the inner-border insets
  // and vertically by `sizes.logoHeight`, preserving aspect ratio. This
  // means the logo can change file (different aspect, different bytes)
  // and the layout still works — we never hardcode logo dimensions.
  const h = sizes.logoHeight;
  const innerW = layout.width - 2 * layout.borderInnerInset;
  doc.image(MME_LOGO_BUFFER, layout.borderInnerInset, startY, {
    fit: [innerW, h],
    align: "center",
  });
  return startY + h;
}

function drawTitleBlock(doc: PDFDoc, data: CertificateData, topBandY: number): number {
  const copy = copyForType(data);
  const y = topBandY + spacing.topBandToTitleMain;

  // MAIN TITLE — "CERTIFICATE" in huge bold navy. The headline. Matches
  // the design-reference convention where this word is the visual anchor
  // of the page, not the sub-type.
  doc.font(fonts.title).fontSize(sizes.titleMain);
  const titleWidth = doc.widthOfString(copy.titleMain);
  const titleX = (layout.width - titleWidth) / 2;
  const titleBaseline = y + sizes.titleMain * 0.7;

  // Left + right horizontal rules flanking the main title — short navy
  // lines with a small navy diamond at the inner end of each rule
  // (closest to the title). The diamond detail distinguishes
  // "ceremonial heading" from "ruled text" — engraved feel.
  const ruleInner = 3;
  doc.save().lineWidth(0.75).strokeColor(colors.title);
  // Left rule + diamond
  doc
    .moveTo(titleX - sizes.titleRuleGap - sizes.titleRuleWidth, titleBaseline)
    .lineTo(titleX - sizes.titleRuleGap - ruleInner * 2, titleBaseline)
    .stroke();
  // Right rule + diamond
  doc
    .moveTo(titleX + titleWidth + sizes.titleRuleGap + ruleInner * 2, titleBaseline)
    .lineTo(titleX + titleWidth + sizes.titleRuleGap + sizes.titleRuleWidth, titleBaseline)
    .stroke();
  // Diamonds at the inner ends.
  doc.fillColor(colors.title);
  for (const x of [titleX - sizes.titleRuleGap - ruleInner, titleX + titleWidth + sizes.titleRuleGap + ruleInner]) {
    doc
      .moveTo(x, titleBaseline - ruleInner)
      .lineTo(x + ruleInner, titleBaseline)
      .lineTo(x, titleBaseline + ruleInner)
      .lineTo(x - ruleInner, titleBaseline)
      .closePath()
      .fill();
  }
  doc.restore();

  doc.fillColor(colors.title).text(copy.titleMain, 0, y, {
    align: "center",
    width: layout.width,
    lineBreak: false,
  });

  // SUB TITLE — "OF ATTENDANCE" / "OF CONTINUING MEDICAL EDUCATION" /
  // "FOR FACULTY" / "FOR POSTER PRESENTER". Cerulean (our brand accent)
  // for the secondary emphasis, matching the design-reference pattern
  // where the type indicator pops in the accent color.
  const titleSubY = y + sizes.titleMain + spacing.titleMainToTitleSub;
  doc
    .font(fonts.subtitle)
    .fontSize(sizes.titleSub)
    .fillColor(colors.cmeHighlight)
    .text(copy.titleSub, 0, titleSubY, {
      align: "center",
      width: layout.width,
      lineBreak: false,
      characterSpacing: 4,
    });

  return titleSubY + sizes.titleSub;
}

function drawRecipientBlock(doc: PDFDoc, titleSubBottomY: number, data: CertificateData): number {
  const introLine = copyForType(data).recipientIntro;
  let y = titleSubBottomY + spacing.titleSubToBody;

  // Recipient intro ("This is to certify that" / "is hereby presented
  // to") rendered in italic — diploma convention differentiates the
  // cred. statement from the rest of the body text. Times-Italic
  // matches the recipient name's font family below, creating typographic
  // coherence in the central focal block.
  y = drawWrappedCentered(doc, introLine, y, {
    font: fonts.recipient, // Times-Italic
    size: sizes.body + 1,
    color: colors.muted,
  });
  y += spacing.bodyToRecipient;

  y = drawWrappedCentered(doc, data.recipient.fullName, y, {
    font: fonts.recipient,
    size: sizes.recipient,
    color: colors.text,
  });
  y += spacing.recipientToDivider;

  // Decorative divider under the recipient name — short line + diamond
  // ornament + short line, centered. Visual closure on the cert's focal
  // point.
  drawRecipientDivider(doc, y);
  y += spacing.dividerToAffil;

  const affilLine = composeAffiliation(data.recipient);
  if (affilLine) {
    y = drawWrappedCentered(doc, affilLine, y, {
      font: fonts.affiliation,
      size: sizes.affiliation,
      color: colors.muted,
    });
  }

  return y;
}

function drawRecipientDivider(doc: PDFDoc, y: number) {
  const w = sizes.recipientDividerWidth;
  const ornament = 4;            // half-diagonal of the centre diamond
  const lineW = (w - ornament * 2 - 8) / 2;  // line on each side, with 4pt gap
  const cx = layout.width / 2;
  const lineY = y + ornament;

  doc
    .save()
    .strokeColor(colors.dividerOrnament)
    .fillColor(colors.dividerOrnament)
    .lineWidth(0.5)
    // Left line
    .moveTo(cx - w / 2, lineY)
    .lineTo(cx - w / 2 + lineW, lineY)
    .stroke()
    // Right line
    .moveTo(cx + w / 2 - lineW, lineY)
    .lineTo(cx + w / 2, lineY)
    .stroke()
    // Center diamond
    .moveTo(cx, lineY - ornament)
    .lineTo(cx + ornament, lineY)
    .lineTo(cx, lineY + ornament)
    .lineTo(cx - ornament, lineY)
    .closePath()
    .fill()
    .restore();
}

function drawEventBlock(
  doc: PDFDoc,
  data: CertificateData,
  startY: number,
): number {
  const copy = copyForType(data);
  let y = startY + spacing.affilToBody;

  // POSTER: render the abstract title in italic on its own line BEFORE
  // the event-connector. Cleaner than stuffing it into the recipient
  // intro line (the v1 approach that overflowed in CEO/MD review).
  if (copy.middleItalic) {
    y = drawWrappedCentered(doc, copy.middleItalic, y, {
      font: fonts.recipient,    // Times-Italic — matches recipient name styling
      size: sizes.eventDates + 2, // ~14pt, smaller than name but italic
      color: colors.text,
    });
    if (copy.middleItalicSuffix) {
      y += 6;
      y = drawWrappedCentered(doc, copy.middleItalicSuffix, y, {
        font: fonts.body,
        size: sizes.body,
        color: colors.text,
      });
    }
    y += spacing.bodyToEventName;
  } else {
    // Non-POSTER types: render the connector ("attended" / "for outstanding
    // contribution to") directly above the event name.
    y = drawWrappedCentered(doc, copy.eventConnector, y, {
      font: fonts.body,
      size: sizes.body,
      color: colors.text,
    });
    y += spacing.bodyToEventName;
  }
  // For POSTER, the "presented at" suffix already played the connector
  // role above, so we go straight to the event name. For others, the
  // connector was rendered above and now we render the event name.

  y = drawWrappedCentered(doc, data.event.name, y, {
    font: fonts.eventName,
    size: sizes.eventName,
    color: colors.title,
  });
  y += spacing.eventNameToDates;

  y = drawWrappedCentered(doc, formatDateRange(data.event.startDate, data.event.endDate), y, {
    font: fonts.body,
    size: sizes.eventDates,
    color: colors.muted,
  });
  y += spacing.datesToVenue;

  const venueLine = composeVenue(data.event);
  if (venueLine) {
    y = drawWrappedCentered(doc, venueLine, y, {
      font: fonts.body,
      size: sizes.venue,
      color: colors.soft,
    });
  }

  return y;
}

function drawCmeBlock(doc: PDFDoc, data: CertificateData, startY: number): number {
  const hours = data.event.cmeHours;
  const accreditations = data.event.accreditations ?? [];
  let y = startY + spacing.venueToHoursLabel;

  if (hours && hours > 0) {
    doc
      .font(fonts.body)
      .fontSize(sizes.hoursLabel)
      .fillColor(colors.text)
      .text("and is hereby awarded", 0, y, {
        align: "center",
        width: layout.width,
        lineBreak: false,
      });
    y += sizes.hoursLabel + spacing.hoursLabelToHours;

    doc
      .font(fonts.hours)
      .fontSize(sizes.hours)
      .fillColor(colors.cmeHighlight)
      .text(`${formatHours(hours)} CPD Hours`, 0, y, {
        align: "center",
        width: layout.width,
        lineBreak: false,
      });
    y += sizes.hours + spacing.hoursToAccreditorBox;
  }

  if (accreditations.length > 0) {
    y = drawAccreditorBox(doc, accreditations, hours ?? null, y);
  }

  return y;
}

/**
 * The boxed "ACCREDITED BY" panel — the design move that gives the
 * accrediting body the visual weight the CEO/MD asked for. Renders a
 * white-ish rounded rect with a gold border, a small "ACCREDITED BY"
 * pre-header in navy, then each accreditor on its own row inside,
 * separated by a thin gold rule when there's more than one.
 */
function drawAccreditorBox(
  doc: PDFDoc,
  accreditations: AccreditationEntry[],
  fallbackHours: number | null,
  startY: number,
): number {
  // Box dimensions — clamp to innerContentWidth (the same width
  // constraint every other variable-length text element uses, so the
  // accreditor panel visually aligns with the body of the cert).
  const boxWidth = layout.innerContentWidth;
  const boxX = (layout.width - boxWidth) / 2;
  const padX = sizes.accreditorBoxPaddingX;
  const padY = sizes.accreditorBoxPaddingY;

  // First measure total height needed: header + each accreditor's
  // (body line + meta line) + (n-1) dividers + row gaps.
  const rowHeight = sizes.accreditorBody + 2 + sizes.accreditorMeta;
  const dividerHeight = 8;
  const headerBlock = sizes.accreditorHeader + 6;
  const innerHeight =
    headerBlock +
    accreditations.length * rowHeight +
    Math.max(0, accreditations.length - 1) * dividerHeight +
    Math.max(0, accreditations.length - 1) * sizes.accreditorBoxRowGap;
  const boxHeight = innerHeight + padY * 2;

  // Background fill + border.
  doc
    .save()
    .fillColor(colors.accreditorBoxBg)
    .strokeColor(colors.accreditorBoxBorder)
    .lineWidth(0.8)
    .roundedRect(boxX, startY, boxWidth, boxHeight, 4)
    .fillAndStroke();

  // "ACCREDITED BY" pre-header — small caps, navy, letter-spaced via
  // pdfkit's characterSpacing option. Sits centered at the top of the
  // box. lineBreak: false on every text() call so doc.y never advances
  // past page-bottom + triggers pagination (the multi-page bug we
  // hit on first render).
  let cursor = startY + padY;
  doc
    .font(fonts.accreditorHeader)
    .fontSize(sizes.accreditorHeader)
    .fillColor(colors.accreditorHeaderText)
    .text("ACCREDITED BY", boxX, cursor, {
      align: "center",
      width: boxWidth,
      characterSpacing: 2,
      lineBreak: false,
    });
  cursor += sizes.accreditorHeader + 6;

  // Each accreditor row — body name in bold navy, reference + hours in
  // smaller muted text below. Multi-body rows separated by a short
  // centered gold rule.
  accreditations.forEach((acc, idx) => {
    if (idx > 0) {
      // Divider rule between rows.
      const dy = cursor + 3;
      doc
        .strokeColor(colors.borderInner)
        .lineWidth(0.4)
        .moveTo(boxX + sizes.accreditorBoxDividerInset, dy)
        .lineTo(boxX + boxWidth - sizes.accreditorBoxDividerInset, dy)
        .stroke();
      cursor += dividerHeight + sizes.accreditorBoxRowGap;
    }

    const bodyLine = friendlyAccreditorName(acc.body);
    doc
      .font(fonts.accreditorBody)
      .fontSize(sizes.accreditorBody)
      .fillColor(colors.accreditorBodyText)
      .text(bodyLine, boxX + padX, cursor, {
        align: "center",
        width: boxWidth - padX * 2,
        lineBreak: false,
      });
    cursor += sizes.accreditorBody + 2;

    const metaLine = composeAccreditorMeta(acc, fallbackHours);
    doc
      .font(fonts.accreditorMeta)
      .fontSize(sizes.accreditorMeta)
      .fillColor(colors.accreditorMeta)
      .text(metaLine, boxX + padX, cursor, {
        align: "center",
        width: boxWidth - padX * 2,
        lineBreak: false,
      });
    cursor += sizes.accreditorMeta;
  });

  doc.restore();
  return startY + boxHeight;
}

/**
 * Footer for portrait layout — two signature blocks (left + right) with a
 * centered gold seal/medallion between them. Matches the diploma
 * convention shown in both CEO/MD design references. Anchored to the
 * page bottom, never reads from `doc.y` so it positions identically
 * regardless of how tall the content above is.
 */
function drawFooter(doc: PDFDoc, data: CertificateData) {
  const cx = layout.width / 2;
  // Signature lines sit roughly 90pt above the bottom inner border —
  // leaves room for the line itself, two label lines, and a small
  // bottom gutter for the serial + issued date row.
  const lineY = layout.height - layout.borderInnerInset - spacing.footerBottomInset;
  const lineW = sizes.signatureLineWidth;
  const sigGutterFromSeal = 80; // gap between seal center and start of signature line

  // Two signature lines — left and right of the central seal.
  const leftLineEnd = cx - sigGutterFromSeal;
  const leftLineStart = leftLineEnd - lineW;
  const rightLineStart = cx + sigGutterFromSeal;
  const rightLineEnd = rightLineStart + lineW;

  doc.save().lineWidth(0.6).strokeColor(colors.muted);
  doc.moveTo(leftLineStart, lineY).lineTo(leftLineEnd, lineY).stroke();
  doc.moveTo(rightLineStart, lineY).lineTo(rightLineEnd, lineY).stroke();
  // Small flourish tick marks at each line end — adds engraving feel.
  for (const x of [leftLineStart, leftLineEnd, rightLineStart, rightLineEnd]) {
    doc.moveTo(x, lineY - 3).lineTo(x, lineY + 3).stroke();
  }
  doc.restore();

  // Signature labels under each line — title + name on two lines.
  // For v1 we don't carry actual signatory names per event; default to
  // "Activity Director" + the organization name. Future iteration could
  // pull from Event.signatories (a new JSON field) so each cert can be
  // signed by named individuals.
  const labelY = lineY + 6;
  doc.font(fonts.signature).fontSize(sizes.signatureLabel).fillColor(colors.muted);
  doc.text("ACTIVITY DIRECTOR", leftLineStart, labelY, {
    width: lineW,
    align: "center",
    lineBreak: false,
    characterSpacing: 1.5,
  });
  doc.text(data.event.organizationName, leftLineStart, labelY + 10, {
    width: lineW,
    align: "center",
    lineBreak: false,
  });
  doc.text("ACCREDITATION OFFICER", rightLineStart, labelY, {
    width: lineW,
    align: "center",
    lineBreak: false,
    characterSpacing: 1.5,
  });
  doc.text(data.event.organizationName, rightLineStart, labelY + 10, {
    width: lineW,
    align: "center",
    lineBreak: false,
  });

  // Central gold seal/medallion between the signatures. Anchored on the
  // signature-line Y so it sits visually balanced with the signatures.
  drawSeal(doc, cx, lineY);

  // Bottom row — serial + issued date, very small and muted, sits at
  // the very bottom inset. This is the audit-trail metadata, not the
  // diploma's focal content.
  const serialY = layout.height - layout.borderInnerInset - 18;
  doc.font(fonts.serial).fontSize(sizes.serial).fillColor(colors.soft);
  doc.text(`Certificate # ${data.serial}`, layout.borderInnerInset + 28, serialY, {
    lineBreak: false,
  });
  doc.text(
    `Issued ${formatDate(data.issuedAt)}`,
    layout.width - layout.borderInnerInset - 28 - 120,
    serialY,
    { width: 120, align: "right", lineBreak: false },
  );

  // Defensive reset of doc.y so any future addition to the renderer
  // doesn't inherit a position past page bottom.
  doc.y = layout.height - 5;
}

/**
 * Gold seal/medallion — concentric rings + the MME monogram embedded in
 * the center. Sits between the two signature lines at the bottom of the
 * cert as the central focal point of the footer band. References both
 * showed a ribbon/medal here; we use a simpler concentric-ring seal
 * because (a) it composes cleanly with our existing assets, (b) ribbon
 * geometry is complex bezier work that's better deferred until we know
 * the CEO/MD likes the seal direction.
 */
function drawSeal(doc: PDFDoc, cx: number, cy: number) {
  const outer = sizes.sealOuterRadius;
  const inner = sizes.sealInnerRadius;
  doc.save();

  // Outer ring — filled gold.
  doc.fillColor(colors.borderInner).circle(cx, cy, outer).fill();
  // Mid ring — slightly lighter, creates the engraved-edge feel.
  doc.fillColor(colors.cornerOrnamentPetal).circle(cx, cy, outer - 2).fill();
  // Inner disc — back to cream so the logo embed reads cleanly.
  doc.fillColor(colors.bgTop).circle(cx, cy, inner).fill();

  // MME logo at the center, fitted inside the inner disc.
  if (MME_LOGO_BUFFER) {
    const fit = sizes.sealLogoFit;
    doc.image(MME_LOGO_BUFFER, cx - fit / 2, cy - fit / 2, {
      fit: [fit, fit],
      align: "center",
    });
  }

  // Thin gold border ring on the inner disc edge for definition.
  doc.lineWidth(0.6).strokeColor(colors.borderInner).circle(cx, cy, inner).stroke();
  // Outer engraved ring — thin navy hairline at the outer edge.
  doc.lineWidth(0.5).strokeColor(colors.borderOuter).circle(cx, cy, outer).stroke();

  doc.restore();
}

// ── Per-type copy ────────────────────────────────────────────────────────────

function copyForType(data: CertificateData): {
  /** Headline word — always "CERTIFICATE". Renders huge in navy. */
  titleMain: string;
  /** Type indicator — "OF ATTENDANCE" / "OF CONTINUING MEDICAL EDUCATION" /
   *  "FOR FACULTY" / "FOR POSTER PRESENTER". Renders smaller below the
   *  main title, in our cerulean accent color. */
  titleSub: string;
  /** Phrase that precedes the recipient name. Grammatically must work
   *  as "<intro> <Dr. Name>" — that's why PRESENTER + POSTER use
   *  "is hereby presented to" rather than the verb-first phrase that
   *  the v1 used (which read backwards once the name was rendered
   *  below the intro). */
  recipientIntro: string;
  /** Connector phrase between the recipient block and the event block.
   *  Grammatically reads as "<...affiliation...> <connector> <event name>". */
  eventConnector: string;
  /**
   * Optional italic line rendered between the affiliation and the
   * event-connector. POSTER cert uses this to surface the abstract
   * title without overstuffing the intro line; other cert types leave
   * it null and the abstract block doesn't render.
   */
  middleItalic: string | null;
  /** Static phrase under the middleItalic (e.g. "presented at"). */
  middleItalicSuffix: string | null;
} {
  switch (data.type) {
    case "ATTENDANCE":
      return {
        titleMain: "CERTIFICATE",
        titleSub: "OF ATTENDANCE",
        recipientIntro: "This is to certify that",
        eventConnector: "attended",
        middleItalic: null,
        middleItalicSuffix: null,
      };
    case "PRESENTER":
      return {
        titleMain: "CERTIFICATE",
        titleSub: "FOR INVITED FACULTY",
        recipientIntro: "is hereby presented to",
        eventConnector: "for outstanding contribution as faculty to",
        middleItalic: null,
        middleItalicSuffix: null,
      };
    case "POSTER": {
      const abstractTitle =
        data.extras.type === "POSTER" ? data.extras.abstractTitle : undefined;
      return {
        titleMain: "CERTIFICATE",
        titleSub: "FOR POSTER PRESENTER",
        recipientIntro: "is hereby presented to",
        eventConnector: "at",
        // Abstract title renders on its own italic line between the
        // affiliation and the event-connector — gives the work its
        // own visual moment instead of cramming it into the intro
        // line (which overflowed in the CEO/MD review).
        middleItalic: abstractTitle ? `"${abstractTitle}"` : null,
        middleItalicSuffix: abstractTitle ? "presented at" : null,
      };
    }
    case "CME":
      return {
        titleMain: "CERTIFICATE",
        titleSub: "OF CONTINUING MEDICAL EDUCATION",
        recipientIntro: "This is to certify that",
        eventConnector: "attended",
        middleItalic: null,
        middleItalicSuffix: null,
      };
  }
  throw new Error(`Unhandled certificate type: ${String(data.type)}`);
}

function titleForType(data: CertificateData): string {
  const c = copyForType(data);
  return `${c.titleMain} ${c.titleSub} — ${data.recipient.fullName}`;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function composeAffiliation(r: CertificateData["recipient"]): string | null {
  const parts: string[] = [];
  if (r.jobTitle) parts.push(r.jobTitle);
  if (r.organization) parts.push(r.organization);
  if (r.country) parts.push(r.country);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function composeVenue(e: CertificateData["event"]): string | null {
  const parts: string[] = [];
  if (e.venue) parts.push(e.venue);
  if (e.city) parts.push(e.city);
  if (e.country) parts.push(e.country);
  return parts.length > 0 ? `held at ${parts.join(", ")}` : null;
}

/**
 * Meta line that goes UNDER the accreditor's name inside the box. When
 * the accreditor supplied a verbatim `officialStatement`, that wins
 * (regulators sometimes require exact wording). Otherwise we compose:
 * "Reference: <ref> · <hours> CPD Hours"
 */
function composeAccreditorMeta(
  acc: AccreditationEntry,
  fallbackHours: number | null | undefined,
): string {
  if (acc.officialStatement) return acc.officialStatement;
  const hours = acc.hours ?? fallbackHours ?? null;
  const parts: string[] = [`Reference: ${acc.reference}`];
  if (hours) parts.push(`${formatHours(hours)} CPD Hours`);
  return parts.join(" · ");
}

function friendlyAccreditorName(body: AccreditationEntry["body"]): string {
  switch (body) {
    case "DHA":
      return "Dubai Health Authority (DHA)";
    case "DOH":
      return "Department of Health Abu Dhabi (DOH)";
    case "SCFHS":
      return "Saudi Commission for Health Specialties (SCFHS)";
    case "EACCME":
      return "EACCME";
    case "ACCME":
      return "ACCME";
    case "OTHER":
      return "The Accrediting Body";
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateRange(start: Date, end: Date): string {
  if (start.toDateString() === end.toDateString()) return formatDate(start);
  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) {
    return `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function formatHours(h: number): string {
  // Drop trailing .0 — "18 CPD Hours" reads better than "18.0 CPD Hours",
  // but 18.5 keeps its decimal. Matches how accreditors write hour counts.
  const rounded = Math.round(h * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
}
