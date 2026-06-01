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

// A4 portrait in pdfkit points (1 pt = 1/72").
// Switched from landscape → portrait 2026-06-01 (Phase B round 3) after
// CEO/MD design references both showed portrait diploma format.
const A4_PORTRAIT_W = 595;
const A4_PORTRAIT_H = 842;

export const CERT_TOKENS = {
  layout: {
    width: A4_PORTRAIT_W,
    height: A4_PORTRAIT_H,
    margin: 60,
    // Outer ornate frame — thicker, navy. Middle pale-gold hairline.
    // Inner thin gold. The triple line + corner rosettes create the
    // formal "engraved diploma" look the references showed.
    borderOuterInset: 22,
    borderInnerInset: 34,
    borderStrokeOuter: 2.8,
    borderStrokeInner: 0.7,
    cornerOrnamentSize: 6,
  },
  colors: {
    // Page background — warm cream/parchment instead of stark white.
    // The #fbf6e8 → #f5ecd2 vertical gradient gives subtle depth, like
    // aged paper. THIS is the single change that flipped the cert from
    // "form" to "diploma." (2026-06-01 — Phase B iteration round 2.)
    bgTop: "#fbf6e8",
    bgBottom: "#f5ecd2",
    text: "#111111",
    muted: "#4a5568",
    soft: "#7a8499",
    // Title + body emphasis — deep navy for formality.
    title: "#1a2e5a",
    // Borders — navy outer, gold inner, the classic cert pairing.
    borderOuter: "#1a2e5a",
    borderInner: "#b8862c", // deeper gold than v1 — more saturated against cream
    borderMid: "#d4af5c",   // pale-gold third rule between outer + inner (triple border)
    cornerOrnament: "#b8862c",
    cornerOrnamentPetal: "#c9a13c",
    dividerOrnament: "#b8862c",
    // The one cerulean accent — the CME hours number. MMG brand peeks
    // through at the most celebratory moment.
    cmeHighlight: "#00aade",
    // Watermark MME logo behind content — opacity is applied via
    // doc.opacity() rather than this color, but the color sets the tone.
    // 0.04 sits just at the edge of perceptibility — the eye registers
    // a presence behind the content without being able to read the
    // logo (which would distract from the recipient's name).
    watermarkOpacity: 0.04,
    // Accreditor panel — slightly warmer cream than the page bg so it
    // visually pops out as a "callout" against the parchment.
    accreditorBoxBg: "#fffaee",
    accreditorBoxBorder: "#b8862c",
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
    logoHeight: 56,
    // Title is now split into TWO lines (matching the design references):
    //   "CERTIFICATE"  — huge, navy, ALL CAPS (the headline)
    //   "OF ATTENDANCE" / "OF CME" / etc — smaller, cerulean accent (the type)
    titleMain: 48,
    titleSub: 18,
    titleRuleWidth: 70,
    titleRuleGap: 18,
    subtitle: 11,
    body: 11,
    recipient: 32,
    recipientDividerWidth: 140,
    affiliation: 12,
    eventName: 17,
    eventDates: 11,
    venue: 10,
    hours: 36,
    hoursLabel: 12,
    accreditorHeader: 9,
    accreditorBody: 13,
    accreditorMeta: 9,
    accreditorBoxPaddingX: 20,
    accreditorBoxPaddingY: 12,
    accreditorBoxRowGap: 5,
    accreditorBoxDividerInset: 14,
    // Seal — a circular gold medallion at the bottom-center between the
    // two signature lines. Contains the MME logo at low scale + concentric
    // gold rings. References showed a center medal/ribbon as a
    // ceremonial focal point.
    sealOuterRadius: 32,
    sealInnerRadius: 26,
    sealLogoFit: 36,
    // Footer: TWO signature blocks (left + right of seal). Each is a
    // signature line + 2 lines of label below.
    signatureLineWidth: 150,
    signature: 9,
    signatureLabel: 8,
    serial: 8,
  },
  spacing: {
    // Top-down vertical rhythm. Each value is the gap between the
    // previous block's bottom and the next block's top.
    // Tuned for A4 portrait (842pt of vertical room — much more than
    // landscape, so we can breathe).
    logoTopFromMargin: 18,
    logoToTopBand: 10,
    topBandToTitleMain: 26,
    titleMainToTitleSub: 14,
    titleSubToBody: 30,
    bodyToRecipient: 14,
    recipientToDivider: 12,
    dividerToAffil: 10,
    affilToBody: 22,
    bodyToEventName: 6,
    eventNameToDates: 6,
    datesToVenue: 4,
    venueToHoursLabel: 24,
    hoursLabelToHours: 2,
    hoursToAccreditorBox: 18,
    // Footer always anchored to the bottom inset; spacing values above
    // only matter for the upper content flow.
    footerBottomInset: 72,
  },
} as const;

export type CertTokens = typeof CERT_TOKENS;
