/**
 * Certificate PDF renderer — pdfkit-based, A4 landscape.
 *
 * One renderCertificate(data) entry point. Dispatches per CertificateType
 * to type-specific copy + the optional CME block. Visual decisions all
 * live in tokens.ts so design iteration with the CEO/MD (Phase B) doesn't
 * touch this file.
 *
 * Phase A consumers: the preview endpoint only — no DB writes, no email.
 * Phase C will reuse this from the issue route, passing data sourced from
 * `IssuedCertificate.recipientSnapshot` so reprints render byte-identical
 * to the original.
 *
 * Why pdfkit directly (not HTML→PDF): a certificate is a fixed precise
 * layout, not flowing content. Direct pdfkit gives us exact coordinates
 * + no surprises from CSS-to-PDF translation. The HTML-template approach
 * the speaker-agreement renderer uses is right for prose-heavy variable
 * layouts; certs are the opposite shape.
 */

import PDFDocument from "pdfkit";
import { CERT_TOKENS } from "./tokens";
import type { CertificateData, AccreditationEntry } from "./types";

type PDFDoc = InstanceType<typeof PDFDocument>;

const { layout, colors, fonts, sizes, spacing } = CERT_TOKENS;

/**
 * Render a certificate to a PDF buffer. Pure: no I/O beyond the in-memory
 * buffer, no DB, no network. Safe to call from the preview endpoint, the
 * issue route, and a future reprint route — same code path, same output.
 */
export async function renderCertificate(data: CertificateData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: layout.margin,
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

  drawBorder(doc);
  drawTitleBlock(doc, data);
  const recipientBottomY = drawRecipientBlock(doc, data);
  const eventBottomY = drawEventBlock(doc, data, recipientBottomY);
  if (data.type === "CME") {
    drawCmeBlock(doc, data, eventBottomY);
  }
  drawFooter(doc, data);

  doc.end();
  return done;
}

// ── Block renderers ──────────────────────────────────────────────────────────

function drawBorder(doc: PDFDoc) {
  doc
    .save()
    .lineWidth(layout.borderStrokeOuter)
    .strokeColor(colors.borderOuter)
    .rect(
      layout.borderOuterInset,
      layout.borderOuterInset,
      layout.width - 2 * layout.borderOuterInset,
      layout.height - 2 * layout.borderOuterInset,
    )
    .stroke()
    .lineWidth(layout.borderStrokeInner)
    .strokeColor(colors.borderInner)
    .rect(
      layout.borderInnerInset,
      layout.borderInnerInset,
      layout.width - 2 * layout.borderInnerInset,
      layout.height - 2 * layout.borderInnerInset,
    )
    .stroke()
    .restore();
}

function drawTitleBlock(doc: PDFDoc, data: CertificateData) {
  const { title, subtitle } = copyForType(data);
  const y = layout.borderInnerInset + spacing.titleTopFromMargin;

  doc
    .font(fonts.title)
    .fontSize(sizes.title)
    .fillColor(colors.accent)
    .text(title, 0, y, { align: "center", width: layout.width });

  doc
    .font(fonts.subtitle)
    .fontSize(sizes.subtitle)
    .fillColor(colors.muted)
    .text(subtitle, 0, doc.y + spacing.titleToSubtitle - sizes.subtitle, {
      align: "center",
      width: layout.width,
    });
}

function drawRecipientBlock(doc: PDFDoc, data: CertificateData): number {
  const introLine = copyForType(data).recipientIntro;
  let y = doc.y + spacing.subtitleToBody;

  doc
    .font(fonts.body)
    .fontSize(sizes.body)
    .fillColor(colors.text)
    .text(introLine, 0, y, { align: "center", width: layout.width });
  y = doc.y + spacing.bodyToRecipient;

  doc
    .font(fonts.recipient)
    .fontSize(sizes.recipient)
    .fillColor(colors.text)
    .text(data.recipient.fullName, 0, y, { align: "center", width: layout.width });
  y = doc.y + spacing.recipientToAffil;

  const affilLine = composeAffiliation(data.recipient);
  if (affilLine) {
    doc
      .font(fonts.affiliation)
      .fontSize(sizes.affiliation)
      .fillColor(colors.muted)
      .text(affilLine, 0, y, { align: "center", width: layout.width });
    y = doc.y;
  }

  return y;
}

function drawEventBlock(
  doc: PDFDoc,
  data: CertificateData,
  startY: number,
): number {
  const verb = copyForType(data).eventVerb;
  let y = startY + spacing.affilToBody;

  doc
    .font(fonts.body)
    .fontSize(sizes.body)
    .fillColor(colors.text)
    .text(verb, 0, y, { align: "center", width: layout.width });
  y = doc.y + spacing.bodyToEventName;

  doc
    .font(fonts.eventName)
    .fontSize(sizes.eventName)
    .fillColor(colors.text)
    .text(data.event.name, 0, y, { align: "center", width: layout.width });
  y = doc.y + spacing.eventNameToDates;

  doc
    .font(fonts.body)
    .fontSize(sizes.eventDates)
    .fillColor(colors.muted)
    .text(formatDateRange(data.event.startDate, data.event.endDate), 0, y, {
      align: "center",
      width: layout.width,
    });
  y = doc.y + spacing.datesToVenue;

  const venueLine = composeVenue(data.event);
  if (venueLine) {
    doc
      .font(fonts.body)
      .fontSize(sizes.venue)
      .fillColor(colors.soft)
      .text(venueLine, 0, y, { align: "center", width: layout.width });
    y = doc.y;
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
      .text("and is hereby awarded", 0, y, { align: "center", width: layout.width });
    y = doc.y + spacing.hoursLabelToHours;

    doc
      .font(fonts.hours)
      .fontSize(sizes.hours)
      .fillColor(colors.cmeHighlight)
      .text(`${formatHours(hours)} CPD Hours`, 0, y, {
        align: "center",
        width: layout.width,
      });
    y = doc.y + spacing.hoursToAccreditor;
  }

  if (accreditations.length > 0) {
    // Render each accreditor on its own line — short, formal, centered.
    // Multi-body events (e.g. DHA + EACCME) get one line each.
    for (const acc of accreditations) {
      const statement = composeAccreditationLine(acc, hours);
      doc
        .font(fonts.accreditor)
        .fontSize(sizes.accreditor)
        .fillColor(colors.muted)
        .text(statement, 0, y, { align: "center", width: layout.width });
      y = doc.y + 2;
    }
  }

  return y;
}

function drawFooter(doc: PDFDoc, data: CertificateData) {
  // Footer always sits a fixed distance from the bottom border — not from
  // the last block's bottom — so different cert types have a stable
  // signature-line position even when CME pushes the content down. That's
  // why this helper takes no Y-cursor input from the caller.
  const footerY = layout.height - layout.borderInnerInset - 70;
  const leftX = layout.borderInnerInset + 30;
  const rightX = layout.width - layout.borderInnerInset - 230;
  const rightW = 200;

  // Left: serial + issued date
  doc
    .font(fonts.serial)
    .fontSize(sizes.serial)
    .fillColor(colors.soft)
    .text(`Certificate # ${data.serial}`, leftX, footerY, { lineBreak: false });
  doc
    .text(`Issued ${formatDate(data.issuedAt)}`, leftX, footerY + 12, {
      lineBreak: false,
    });

  // Right: signature line + label
  doc
    .save()
    .moveTo(rightX, footerY + 12)
    .lineTo(rightX + rightW, footerY + 12)
    .lineWidth(0.5)
    .strokeColor(colors.muted)
    .stroke()
    .restore();
  doc
    .font(fonts.signature)
    .fontSize(sizes.signatureLabel)
    .fillColor(colors.muted)
    .text(`${data.event.organizationName} — Activity Director`, rightX, footerY + 18, {
      width: rightW,
      align: "center",
      lineBreak: false,
    });
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
  // Unreachable under the current CertificateType enum — only here so
  // TypeScript's reachability analysis stops complaining about a
  // missing return. If a new enum value is added without a matching
  // case above, this throws at runtime; the right long-term shape is
  // a never-guard, but Prisma's generated enum + this project's TS
  // config don't currently narrow to never after exhaustive cases.
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

function composeAccreditationLine(
  acc: AccreditationEntry,
  fallbackHours: number | null | undefined,
): string {
  if (acc.officialStatement) return acc.officialStatement;
  const hours = acc.hours ?? fallbackHours ?? null;
  const hoursPart = hours ? ` for ${formatHours(hours)} CPD Hours` : "";
  return `Accredited by ${friendlyAccreditorName(acc.body)} reference ${acc.reference}${hoursPart}`;
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
      return "the accrediting body";
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
