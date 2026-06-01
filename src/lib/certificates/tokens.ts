/**
 * Design tokens for the certificate templates.
 *
 * This file IS the CEO/MD iteration surface. When they say "make the title
 * bigger" or "use MMG cerulean for the border," the change lands here in
 * one line — not in the renderer's layout code. The renderer reads every
 * visual decision from this object.
 *
 * Phase B will likely revise most of these values after the CEO/MD reviews
 * the first rendered drafts. Document every change in the commit message so
 * we have a clean audit of "why does the cert look like this."
 */

// A4 landscape in pdfkit points (1 pt = 1/72").
const A4_LANDSCAPE_W = 842;
const A4_LANDSCAPE_H = 595;

export const CERT_TOKENS = {
  layout: {
    width: A4_LANDSCAPE_W,
    height: A4_LANDSCAPE_H,
    // Outer document margin — pdfkit's text auto-wrap respects this when
    // we don't pass explicit coordinates. Most cert text uses absolute
    // positioning so this only affects the implicit-positioned bits.
    margin: 60,
    // Decorative border insets — outer frame at 25pt from page edge,
    // inner frame at 35pt. The gap creates the classic double-line
    // certificate look without needing an SVG/image asset.
    borderOuterInset: 25,
    borderInnerInset: 35,
    borderStrokeOuter: 2,
    borderStrokeInner: 0.5,
  },
  colors: {
    text: "#1a1a1a",
    muted: "#555555",
    soft: "#888888",
    // MMG brand cerulean — matches the dashboard primary color so
    // certificates feel part of the same identity system. CEO/MD may
    // want to swap this for a more "formal" navy/burgundy on the cert
    // specifically — change in one place when they say so.
    accent: "#00aade",
    borderOuter: "#00aade",
    borderInner: "#c9a13c", // gold-leaf tint — formal cert convention
    cmeHighlight: "#00aade",
    accreditorBoxBg: "#f7f9fc",
    accreditorBoxBorder: "#d6dce3",
  },
  fonts: {
    // pdfkit's built-in PostScript fonts — no TTF embedding needed.
    // Switch to custom TTFs when CEO/MD picks a brand font; the renderer
    // would call doc.registerFont() once at module init.
    title: "Helvetica-Bold",
    subtitle: "Helvetica",
    body: "Helvetica",
    recipient: "Times-Italic", // formal cursive feel for the name
    affiliation: "Helvetica",
    eventName: "Helvetica-Bold",
    hours: "Helvetica-Bold",
    accreditor: "Helvetica",
    signature: "Helvetica",
    serial: "Helvetica",
  },
  sizes: {
    title: 26,
    subtitle: 13,
    body: 12,
    recipient: 30,
    affiliation: 13,
    eventName: 18,
    eventDates: 12,
    venue: 11,
    hours: 32,
    hoursLabel: 13,
    accreditor: 10,
    signature: 11,
    signatureLabel: 9,
    serial: 9,
  },
  spacing: {
    // Vertical rhythm — distances from the previous block's baseline. All
    // values in points. The renderer flows top-down using a `cursor.y`
    // that increments by `block.height + spacing.gap`.
    titleTopFromMargin: 45,
    titleToSubtitle: 14,
    subtitleToBody: 28,
    bodyToRecipient: 14,
    recipientToAffil: 4,
    affilToBody: 22,
    bodyToEventName: 6,
    eventNameToDates: 8,
    datesToVenue: 4,
    venueToHoursLabel: 22,
    hoursLabelToHours: 4,
    hoursToAccreditor: 18,
  },
} as const;

export type CertTokens = typeof CERT_TOKENS;
