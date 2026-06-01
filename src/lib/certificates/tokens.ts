/**
 * Design tokens for the certificate templates.
 *
 * This file IS the CEO/MD iteration surface. When they say "make the title
 * bigger" or "use a deeper navy for the border," the change lands here in
 * one line — not in the renderer's layout code. The renderer reads every
 * visual decision from this object.
 *
 * 2026-06-01 — first iteration round (Phase B kick-off):
 *   - Palette shifted from cerulean-everywhere to formal **navy + gold**.
 *     This is the conventional cert palette and feels more
 *     "framed-on-the-wall" than the dashboard's cerulean. Cerulean is
 *     RETAINED for the CME hours number — the one place where MMG brand
 *     identity + celebratory weight should overlap.
 *   - Recipient name bumped from 30pt → 36pt; the name is the cert's
 *     focal point.
 *   - New decorative tokens (rule decorators, corner ornaments, divider
 *     ornaments) so the renderer can produce flourishes without hand-
 *     coding the geometry each time.
 *   - New accreditor-box tokens — the boxed "ACCREDITED BY" panel that
 *     gives CME accreditation visual weight.
 */

// A4 landscape in pdfkit points (1 pt = 1/72").
const A4_LANDSCAPE_W = 842;
const A4_LANDSCAPE_H = 595;

export const CERT_TOKENS = {
  layout: {
    width: A4_LANDSCAPE_W,
    height: A4_LANDSCAPE_H,
    margin: 60,
    // Outer ornate frame — thicker, navy. Inner frame — thin, gold. The
    // gap between the two creates the formal double-line look. Corner
    // ornaments (small diamonds in `colors.borderInner`) sit on top.
    borderOuterInset: 18,
    borderInnerInset: 28,
    borderStrokeOuter: 2.5,
    borderStrokeInner: 0.6,
    cornerOrnamentSize: 6,
  },
  colors: {
    text: "#111111",
    muted: "#4a5568",
    soft: "#7a8499",
    // Title + body emphasis — deep navy for formality.
    title: "#1a2e5a",
    // Borders — navy outer, gold inner, the classic cert pairing.
    borderOuter: "#1a2e5a",
    borderInner: "#c9a13c",
    cornerOrnament: "#c9a13c",
    dividerOrnament: "#c9a13c",
    // The one cerulean accent — the CME hours number. MMG brand peeks
    // through at the most celebratory moment.
    cmeHighlight: "#00aade",
    // Accreditor panel — subtle off-white with a navy header rule.
    accreditorBoxBg: "#fbfbf6",
    accreditorBoxBorder: "#c9a13c",
    accreditorHeaderText: "#1a2e5a",
    accreditorBodyText: "#1a1a1a",
    accreditorMeta: "#4a5568",
  },
  fonts: {
    // pdfkit's built-in PostScript fonts — no TTF embedding needed yet.
    // Future iteration (if CEO/MD wants a brand serif) registers a TTF
    // at renderer init via doc.registerFont().
    title: "Helvetica-Bold",
    subtitle: "Helvetica",
    body: "Helvetica",
    recipient: "Times-Italic",      // formal cursive feel for the name
    affiliation: "Helvetica",
    eventName: "Helvetica-Bold",
    hours: "Helvetica-Bold",
    accreditorHeader: "Helvetica-Bold",
    accreditorBody: "Helvetica-Bold",
    accreditorMeta: "Helvetica",
    signature: "Helvetica",
    serial: "Helvetica",
  },
  sizes: {
    logoHeight: 50,
    title: 24,
    titleRuleWidth: 60,         // length of the horizontal rule on each side of the title
    titleRuleGap: 16,           // gap between rule end and title text
    subtitle: 11,
    body: 12,
    recipient: 36,
    recipientDividerWidth: 110, // total width of the line+ornament+line under the name
    affiliation: 13,
    eventName: 18,
    eventDates: 12,
    venue: 11,
    hours: 36,
    hoursLabel: 13,
    accreditorHeader: 9,
    accreditorBody: 14,
    accreditorMeta: 10,
    accreditorBoxPaddingX: 22,
    accreditorBoxPaddingY: 14,
    accreditorBoxRowGap: 6,
    accreditorBoxDividerInset: 14, // inset of the multi-body separator line from each side
    signature: 11,
    signatureLabel: 9,
    serial: 9,
  },
  spacing: {
    // Top-down vertical rhythm. Each value is the gap between the
    // previous block's bottom and the next block's top.
    logoTopFromMargin: 16,
    logoToTitle: 18,
    titleToSubtitle: 8,
    subtitleToBody: 22,
    bodyToRecipient: 12,
    recipientToDivider: 8,
    dividerToAffil: 8,
    affilToBody: 18,
    bodyToEventName: 4,
    eventNameToDates: 6,
    datesToVenue: 3,
    venueToHoursLabel: 18,
    hoursLabelToHours: 2,
    hoursToAccreditorBox: 14,
    accreditorBoxBottomToFooter: 10,
  },
} as const;

export type CertTokens = typeof CERT_TOKENS;
