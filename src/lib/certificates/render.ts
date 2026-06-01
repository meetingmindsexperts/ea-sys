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
    layout: "landscape",
    // Document margins set to 0 — we manage layout absolutely via the
    // tokens, and pdfkit's auto-pagination triggers when text crosses
    // `pageHeight - bottomMargin`. With margin: 60 (the default-ish),
    // the cert overflowed onto page 2 the moment we added the
    // decorative top band. Setting margins to 0 means pdfkit never
    // paginates the cert — exactly what we want for a single-page
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

  // Draw order is intentional — each step sits visually on top of the
  // previous. Background and watermark first (deepest layer), then
  // borders, then content. The watermark goes between background and
  // borders so the borders aren't dimmed by it.
  drawBackground(doc);
  drawWatermark(doc);
  drawBorder(doc);
  const logoBottomY = drawLogo(doc);
  drawTopBand(doc, logoBottomY);
  const subtitleBottomY = drawTitleBlock(doc, data, logoBottomY + spacing.logoToTitle * 0.4);
  const recipientBottomY = drawRecipientBlock(doc, subtitleBottomY, data);
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
 * Large faint MME logo behind the content as a watermark/seal. Embossed-
 * look without needing PDF transparency tricks — just very low opacity.
 * Centered both axes. Sized to roughly fill the inner content area so
 * it reads as the cert's "underlay" rather than a decoration.
 */
function drawWatermark(doc: PDFDoc) {
  if (!MME_LOGO_BUFFER) return;
  const innerW = layout.width - 2 * layout.borderInnerInset;
  const innerH = layout.height - 2 * layout.borderInnerInset;
  // Fit the watermark inside a centered box ~60% of the inner cert area
  // — large enough to feel like a seal, small enough not to overpower.
  const wmBox = Math.min(innerW, innerH) * 0.6;
  doc.save();
  doc.opacity(colors.watermarkOpacity);
  doc.image(MME_LOGO_BUFFER, (layout.width - wmBox) / 2, (layout.height - wmBox) / 2, {
    fit: [wmBox, wmBox],
    align: "center",
  });
  doc.restore();
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

function drawTitleBlock(doc: PDFDoc, data: CertificateData, logoBottomY: number): number {
  const { title, subtitle } = copyForType(data);
  const y = logoBottomY + spacing.logoToTitle;

  // Measure title width so we can place the rule decorators on each side.
  doc.font(fonts.title).fontSize(sizes.title);
  const titleWidth = doc.widthOfString(title);
  const titleX = (layout.width - titleWidth) / 2;
  const titleBaseline = y + sizes.title * 0.7; // approximate visual middle

  // Left + right horizontal rules — short navy lines flanking the title.
  // This single touch is what makes the title feel "ceremonial" rather
  // than just "bold heading."
  const ruleY = titleBaseline;
  doc
    .save()
    .lineWidth(0.75)
    .strokeColor(colors.title)
    .moveTo(titleX - sizes.titleRuleGap - sizes.titleRuleWidth, ruleY)
    .lineTo(titleX - sizes.titleRuleGap, ruleY)
    .stroke()
    .moveTo(titleX + titleWidth + sizes.titleRuleGap, ruleY)
    .lineTo(titleX + titleWidth + sizes.titleRuleGap + sizes.titleRuleWidth, ruleY)
    .stroke()
    .restore();

  // The title itself, on top of the rules. lineBreak: false prevents
  // pdfkit from advancing doc.y past page-bottom (which auto-paginates
  // the cert into a second/third blank page). All absolute-positioned
  // text in this renderer uses the same pattern.
  doc
    .fillColor(colors.title)
    .text(title, 0, y, { align: "center", width: layout.width, lineBreak: false });

  // Optional subtitle (organization name) just below.
  const subtitleY = y + sizes.title + spacing.titleToSubtitle;
  doc
    .font(fonts.subtitle)
    .fontSize(sizes.subtitle)
    .fillColor(colors.muted)
    .text(subtitle, 0, subtitleY, {
      align: "center",
      width: layout.width,
      lineBreak: false,
    });
  return subtitleY + sizes.subtitle;
}

function drawRecipientBlock(doc: PDFDoc, subtitleBottomY: number, data: CertificateData): number {
  const introLine = copyForType(data).recipientIntro;
  let y = subtitleBottomY + spacing.subtitleToBody;

  doc
    .font(fonts.body)
    .fontSize(sizes.body)
    .fillColor(colors.text)
    .text(introLine, 0, y, { align: "center", width: layout.width, lineBreak: false });
  y += sizes.body + spacing.bodyToRecipient;

  doc
    .font(fonts.recipient)
    .fontSize(sizes.recipient)
    .fillColor(colors.text)
    .text(data.recipient.fullName, 0, y, {
      align: "center",
      width: layout.width,
      lineBreak: false,
    });
  y += sizes.recipient + spacing.recipientToDivider;

  // Decorative divider under the recipient name — short line + diamond
  // ornament + short line, centered. Visual closure on the cert's focal
  // point.
  drawRecipientDivider(doc, y);
  y += spacing.dividerToAffil;

  const affilLine = composeAffiliation(data.recipient);
  if (affilLine) {
    doc
      .font(fonts.affiliation)
      .fontSize(sizes.affiliation)
      .fillColor(colors.muted)
      .text(affilLine, 0, y, { align: "center", width: layout.width, lineBreak: false });
    y += sizes.affiliation;
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
  const verb = copyForType(data).eventVerb;
  let y = startY + spacing.affilToBody;

  // All absolute-positioned text uses `lineBreak: false` so doc.y never
  // advances past page-bottom mid-render (which would auto-paginate into
  // blank pages 2+3). Y position is tracked explicitly via the local
  // `y` variable instead of reading doc.y.
  doc
    .font(fonts.body)
    .fontSize(sizes.body)
    .fillColor(colors.text)
    .text(verb, 0, y, { align: "center", width: layout.width, lineBreak: false });
  y += sizes.body + spacing.bodyToEventName;

  doc
    .font(fonts.eventName)
    .fontSize(sizes.eventName)
    .fillColor(colors.title)
    .text(data.event.name, 0, y, {
      align: "center",
      width: layout.width,
      lineBreak: false,
    });
  y += sizes.eventName + spacing.eventNameToDates;

  doc
    .font(fonts.body)
    .fontSize(sizes.eventDates)
    .fillColor(colors.muted)
    .text(formatDateRange(data.event.startDate, data.event.endDate), 0, y, {
      align: "center",
      width: layout.width,
      lineBreak: false,
    });
  y += sizes.eventDates + spacing.datesToVenue;

  const venueLine = composeVenue(data.event);
  if (venueLine) {
    doc
      .font(fonts.body)
      .fontSize(sizes.venue)
      .fillColor(colors.soft)
      .text(venueLine, 0, y, {
        align: "center",
        width: layout.width,
        lineBreak: false,
      });
    y += sizes.venue;
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
  // Box dimensions — width is a centered fraction of page width so it
  // never butts against the inner border, height is computed from the
  // content row count.
  const boxWidth = Math.min(560, layout.width - 2 * layout.borderInnerInset - 60);
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

function drawFooter(doc: PDFDoc, data: CertificateData) {
  // Footer always sits a fixed distance from the bottom border — not from
  // the last block's bottom — so different cert types have a stable
  // signature-line position even when CME pushes the content down. That's
  // why this helper takes no Y-cursor input from the caller.
  const footerY = layout.height - layout.borderInnerInset - 70;
  const leftX = layout.borderInnerInset + 35;
  const rightX = layout.width - layout.borderInnerInset - 270;
  const rightW = 240;

  // Left: serial + issued date.
  doc
    .font(fonts.serial)
    .fontSize(sizes.serial)
    .fillColor(colors.soft)
    .text(`Certificate # ${data.serial}`, leftX, footerY, { lineBreak: false });
  doc.text(`Issued ${formatDate(data.issuedAt)}`, leftX, footerY + 12, {
    lineBreak: false,
  });

  // Right: signature line + small ornament + label.
  const lineY = footerY + 14;
  doc
    .save()
    .moveTo(rightX, lineY)
    .lineTo(rightX + rightW, lineY)
    .lineWidth(0.6)
    .strokeColor(colors.muted)
    .stroke()
    // Small flourish ornament at line ends (tiny vertical ticks)
    .moveTo(rightX, lineY - 3)
    .lineTo(rightX, lineY + 3)
    .stroke()
    .moveTo(rightX + rightW, lineY - 3)
    .lineTo(rightX + rightW, lineY + 3)
    .stroke()
    .restore();
  doc
    .font(fonts.signature)
    .fontSize(sizes.signatureLabel)
    .fillColor(colors.muted)
    .text(`${data.event.organizationName} · Activity Director`, rightX, lineY + 6, {
      width: rightW,
      align: "center",
      lineBreak: false,
    });

  // Defensive reset: any subsequent operation that reads doc.y (e.g.,
  // pdfkit's implicit text positioning if a feature were added later)
  // gets a safe value, not "off the page" from text rendering above.
  doc.y = layout.height - layout.borderInnerInset - 30;
}

// ── Per-type copy ────────────────────────────────────────────────────────────

function copyForType(data: CertificateData): {
  title: string;
  subtitle: string;
  recipientIntro: string;
  eventVerb: string;
} {
  switch (data.type) {
    case "ATTENDANCE":
      return {
        title: "CERTIFICATE OF ATTENDANCE",
        subtitle: data.event.organizationName,
        recipientIntro: "This is to certify that",
        eventVerb: "attended",
      };
    case "PRESENTER":
      return {
        title: "CERTIFICATE OF APPRECIATION — FACULTY",
        subtitle: data.event.organizationName,
        recipientIntro: "is hereby recognized for outstanding contribution as faculty to",
        eventVerb: "at",
      };
    case "POSTER": {
      const abstractTitle =
        data.extras.type === "POSTER" ? data.extras.abstractTitle : undefined;
      return {
        title: "CERTIFICATE OF APPRECIATION — POSTER PRESENTER",
        subtitle: data.event.organizationName,
        recipientIntro: abstractTitle
          ? `is hereby recognized for the poster titled "${abstractTitle}" presented at`
          : "is hereby recognized for the poster presented at",
        eventVerb: "at",
      };
    }
    case "CME":
      return {
        title: "CERTIFICATE OF CONTINUING MEDICAL EDUCATION",
        subtitle: data.event.organizationName,
        recipientIntro: "This is to certify that",
        eventVerb: "attended",
      };
  }
  throw new Error(`Unhandled certificate type: ${String(data.type)}`);
}

function titleForType(data: CertificateData): string {
  return `${copyForType(data).title} — ${data.recipient.fullName}`;
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
