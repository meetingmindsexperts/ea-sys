/**
 * Built-in "standard" certificate templates — the clone-and-edit starting
 * point for Attendance and Appreciation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Creating a template today gives you an empty row: no background, no text
 * boxes, and a preview that renders an instructional placeholder page. The
 * organizer's first move is therefore to reproduce, from nothing, a layout
 * every certificate shares. This module ships that layout.
 *
 * MODELLED ON A REAL SETUP, NOT AN INVENTED ONE
 * ---------------------------------------------
 * The geometry, fonts and colour here are taken from the OSH Monthly Meeting
 * 2026 CME templates — as of July 2026 the only certificate setup configured
 * on a real event, and therefore the house convention:
 *   - page is A4 portrait exported at 300 DPI, so the coordinate space is
 *     2480 x 3508 "points" rather than the 595 x 842 of true A4. Designers
 *     export raster-backed PDFs at print DPI; matching that scale means an
 *     organizer can swap our generated background for their designer's
 *     artwork and every text box still lands where it should.
 *   - one centred content column at x=240, width=2000 (symmetric 240pt margins)
 *   - Times-Roman / Times-Bold, navy #1a2e5a, body 60pt, headline 90pt
 *   - the line stack: confirm → name → relation → event → date → accreditation
 *
 * WHAT THIS FIXES ABOUT THAT SETUP
 * --------------------------------
 * Of OSH's nine text boxes, only ONE ({{recipientName}}) is a token. The
 * event name, the date, the accreditor, the accreditation number and the CME
 * hours are all typed literals — so each of the four role variants was made
 * by duplicating and retyping, and none of it tracks the event record. Here
 * every one of those lines is a token, so a clone needs no retyping and the
 * certificate cannot disagree with the event it was issued for.
 *
 * TWO DERIVED-NOT-DUPLICATED INVARIANTS
 * -------------------------------------
 * 1. The background PDF and the text boxes are computed from the SAME layout
 *    constants below. A background shipped as a binary asset would drift
 *    silently the first time someone nudged a coordinate — the rule under the
 *    recipient's name would stop being under the recipient's name and nothing
 *    would fail.
 * 2. Every token used here is checked against `token-catalog.ts` by
 *    `starter-template.test.ts`. A starter that referenced a token the
 *    renderer doesn't resolve would print a blank line on every certificate
 *    and log a warn per render — the failure is silent on the page, so it has
 *    to be loud in CI.
 */

import { PDFDocument, rgb } from "pdf-lib";

import type { CertificateTextBox, CertificateType } from "./types";

// ── Layout constants — the single source of truth for BOTH the generated
//    background and the text-box coordinates. ────────────────────────────────

/** A4 portrait at 300 DPI, matching the observed designer export convention. */
export const STARTER_PAGE_WIDTH = 2480;
export const STARTER_PAGE_HEIGHT = 3508;

/** Centred content column — 240pt margins either side, as OSH uses. */
const CONTENT_X = 240;
const CONTENT_WIDTH = 2000;

const NAVY = "#1a2e5a";
const NAVY_RGB = rgb(0x1a / 255, 0x2e / 255, 0x5a / 255);
/** Muted rule/border tone — navy at ~35% against white. */
const RULE_RGB = rgb(0.62, 0.66, 0.74);

/** Box height for a given font size. The renderer centres text vertically in
 *  the box, so this only needs to comfortably clear the glyphs. */
function boxHeight(size: number): number {
  return Math.round(size * 1.5);
}

/** A horizontal rule drawn on the background, positioned from the page top. */
interface Rule {
  /** Distance from the top of the page to the rule. */
  yFromTop: number;
  width: number;
  thickness: number;
}

// ── Text box construction ────────────────────────────────────────────────────

type BoxSpec = {
  content: string;
  yFromTop: number;
  size: number;
  bold?: boolean;
  /** Overrides the full content column — used for the paired footer boxes. */
  x?: number;
  width?: number;
  align?: CertificateTextBox["align"];
};

/**
 * Deterministic ids. The renderer only needs uniqueness within the template,
 * and stable ids make the generated starter diffable and its tests readable —
 * a random uuid per call would make neither possible.
 */
function boxId(category: CertificateType, index: number): string {
  return `starter-${category.toLowerCase()}-${String(index).padStart(2, "0")}`;
}

function toTextBox(spec: BoxSpec, category: CertificateType, index: number): CertificateTextBox {
  return {
    id: boxId(category, index),
    content: spec.content,
    x: spec.x ?? CONTENT_X,
    y: spec.yFromTop,
    width: spec.width ?? CONTENT_WIDTH,
    height: boxHeight(spec.size),
    font: spec.bold ? "Times-Bold" : "Times-Roman",
    size: spec.size,
    color: NAVY,
    align: spec.align ?? "center",
  };
}

/**
 * What the event actually has configured. The starter adapts to it: an event
 * with no accreditation should not be handed a certificate reading
 * "Total Hour/s Awarded:" with nothing after the colon, and one with no venue
 * should not carry a blank line where the venue would be. Those lines are
 * omitted rather than shipped-empty, because a label with no value is worse
 * than an absent line and the organizer can always add it back.
 */
export interface StarterEventShape {
  hasVenue: boolean;
  hasCme: boolean;
  hasAccreditation: boolean;
}

/** Vertical rhythm, shared by the boxes and the background rules. */
const Y = {
  orgName: 470,
  title: 660,
  intro: 1100,
  name: 1340,
  relation: 1680,
  eventName: 1850,
  // Comfortably clear of the 135pt-tall event-name box above it (which ends at
  // 1985) — the boxes don't wrap, so a long presentation title stays on one
  // line and must not crowd the line above.
  subtitle: 2010,
  date: 2160,
  venue: 2270,
  accreditationName: 2430,
  accreditationRef: 2535,
  cmeHours: 2640,
  signatureLabel: 3020,
  footer: 3300,
} as const;

const SIGNATURE_COLUMN_WIDTH = 700;
const SIGNATURE_LEFT_X = CONTENT_X + 60;
const SIGNATURE_RIGHT_X = CONTENT_X + CONTENT_WIDTH - SIGNATURE_COLUMN_WIDTH - 60;

/**
 * The text boxes for a starter template.
 *
 * Wording note: the relation line for APPRECIATION uses `{{role}}` inline, and
 * the route sets the template's `role` to "Speaker". That is the whole point
 * of the role field — duplicate the template, change one dropdown, and the
 * sentence re-words itself. OSH instead retyped "as a Speaker for the" /
 * "as a Moderator for the" / "as an Organizer for the" across three clones.
 */
export function starterTextBoxes(
  category: CertificateType,
  event: StarterEventShape,
): CertificateTextBox[] {
  const specs: BoxSpec[] = [];

  specs.push({ content: "{{organizationName}}", yFromTop: Y.orgName, size: 54, bold: true });
  specs.push({
    content:
      category === "ATTENDANCE" ? "CERTIFICATE OF ATTENDANCE" : "CERTIFICATE OF APPRECIATION",
    yFromTop: Y.title,
    size: 110,
    bold: true,
  });

  if (category === "ATTENDANCE") {
    specs.push({ content: "We hereby confirm that", yFromTop: Y.intro, size: 60 });
    specs.push({ content: "{{recipientName}}", yFromTop: Y.name, size: 90, bold: true });
    specs.push({ content: "has attended", yFromTop: Y.relation, size: 60 });
  } else {
    specs.push({ content: "This is to certify that", yFromTop: Y.intro, size: 60 });
    specs.push({ content: "{{recipientName}}", yFromTop: Y.name, size: 90, bold: true });
    specs.push({ content: "contributed as {{role}} to", yFromTop: Y.relation, size: 60 });
  }

  specs.push({ content: "{{eventName}}", yFromTop: Y.eventName, size: 90, bold: true });

  // Appreciation certificates name the presentation. A recipient with no
  // abstract renders this line blank, which reads fine — unlike a label.
  if (category === "APPRECIATION") {
    specs.push({ content: "{{abstractTitle}}", yFromTop: Y.subtitle, size: 57, bold: true });
  }

  specs.push({ content: "held on {{eventDateRange}}", yFromTop: Y.date, size: 60 });
  if (event.hasVenue) {
    specs.push({ content: "{{venueLine}}", yFromTop: Y.venue, size: 54 });
  }

  if (event.hasAccreditation) {
    specs.push({
      content: "Accredited by {{accreditationName}}",
      yFromTop: Y.accreditationName,
      size: 60,
    });
    specs.push({
      content: "Accreditation #: {{accreditationReference}}",
      yFromTop: Y.accreditationRef,
      size: 60,
    });
  }
  if (event.hasCme) {
    specs.push({ content: "Total Hour/s Awarded: {{cmeHours}}", yFromTop: Y.cmeHours, size: 60 });
  }

  // Signature labels sit under the rules the background draws.
  specs.push({
    content: "Conference Chair",
    yFromTop: Y.signatureLabel,
    size: 48,
    x: SIGNATURE_LEFT_X,
    width: SIGNATURE_COLUMN_WIDTH,
  });
  specs.push({
    content: "CME / CPD Director",
    yFromTop: Y.signatureLabel,
    size: 48,
    x: SIGNATURE_RIGHT_X,
    width: SIGNATURE_COLUMN_WIDTH,
  });

  // Footer: serial left, issue date right. Two boxes rather than one joined
  // string so neither needs a separator glyph (the standard-14 fonts encode
  // WinAnsi only, and a stray separator is an avoidable encoding risk).
  specs.push({
    content: "Certificate No. {{certificateSerial}}",
    yFromTop: Y.footer,
    size: 36,
    x: CONTENT_X,
    width: CONTENT_WIDTH / 2,
    align: "left",
  });
  specs.push({
    content: "Issued {{issuedDate}}",
    yFromTop: Y.footer,
    size: 36,
    x: CONTENT_X + CONTENT_WIDTH / 2,
    width: CONTENT_WIDTH / 2,
    align: "right",
  });

  return specs.map((spec, i) => toTextBox(spec, category, i));
}

// ── Background PDF ───────────────────────────────────────────────────────────

/**
 * Rules are positioned RELATIVE to the boxes they belong under, so the two can
 * never drift apart: change `Y.name` and the rule under the recipient's name
 * follows it.
 */
function starterRules(): Rule[] {
  const titleBottom = Y.title + boxHeight(110);
  const nameBottom = Y.name + boxHeight(90);
  return [
    { yFromTop: titleBottom + 40, width: 760, thickness: 5 },
    { yFromTop: nameBottom + 24, width: 1500, thickness: 3 },
  ];
}

/**
 * Generate the starter background: frame and rules only.
 *
 * Deliberately NO text. Everything a reader sees as words is a text box, so
 * every word is editable in the canvas editor without a designer. Baking
 * wording into the background would make "CERTIFICATE OF ATTENDANCE" and the
 * signature captions unreachable to the organizer, which is precisely the
 * dependency this feature is meant to remove.
 */
export async function buildStarterBackgroundPdf(category: CertificateType): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([STARTER_PAGE_WIDTH, STARTER_PAGE_HEIGHT]);

  // Convert "distance from page top" to pdf-lib's bottom-left origin.
  const fromTop = (y: number) => STARTER_PAGE_HEIGHT - y;

  // Double border.
  const outerInset = 110;
  page.drawRectangle({
    x: outerInset,
    y: outerInset,
    width: STARTER_PAGE_WIDTH - outerInset * 2,
    height: STARTER_PAGE_HEIGHT - outerInset * 2,
    borderColor: NAVY_RGB,
    borderWidth: 8,
  });
  const innerInset = outerInset + 26;
  page.drawRectangle({
    x: innerInset,
    y: innerInset,
    width: STARTER_PAGE_WIDTH - innerInset * 2,
    height: STARTER_PAGE_HEIGHT - innerInset * 2,
    borderColor: RULE_RGB,
    borderWidth: 2,
  });

  // Centred rules under the title and the recipient name.
  for (const rule of starterRules()) {
    const x = (STARTER_PAGE_WIDTH - rule.width) / 2;
    page.drawLine({
      start: { x, y: fromTop(rule.yFromTop) },
      end: { x: x + rule.width, y: fromTop(rule.yFromTop) },
      thickness: rule.thickness,
      color: rule.thickness >= 5 ? NAVY_RGB : RULE_RGB,
    });
  }

  // Signature rules, sitting just above their labels.
  const signatureRuleY = fromTop(Y.signatureLabel - 20);
  for (const x of [SIGNATURE_LEFT_X, SIGNATURE_RIGHT_X]) {
    page.drawLine({
      start: { x, y: signatureRuleY },
      end: { x: x + SIGNATURE_COLUMN_WIDTH, y: signatureRuleY },
      thickness: 3,
      color: RULE_RGB,
    });
  }

  pdfDoc.setTitle(`Standard ${category.toLowerCase()} certificate background`);
  pdfDoc.setCreator("EA-SYS starter certificate template");
  pdfDoc.setSubject(
    "Generated starter background — replace with your designer's artwork at the same page size (2480 x 3508) to keep the text boxes aligned.",
  );

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/** Default template name per category. */
export function starterTemplateName(category: CertificateType): string {
  return category === "ATTENDANCE" ? "Standard Attendance" : "Standard Appreciation";
}

/**
 * Default role for the starter. Appreciation certificates are role-shaped by
 * nature — "Speaker" is the common case and the organizer duplicates for
 * Moderator / Organiser. Attendance carries no role.
 */
export function starterTemplateRole(category: CertificateType): string | null {
  return category === "APPRECIATION" ? "Speaker" : null;
}
