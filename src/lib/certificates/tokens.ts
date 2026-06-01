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
    // Outer ornate frame — thicker, navy. Middle pale-cerulean hairline.
    // Inner thin cerulean. The triple line + corner rosettes create the
    // formal "engraved diploma" look the references showed.
    borderOuterInset: 22,
    borderInnerInset: 34,
    borderStrokeOuter: 2.8,
    borderStrokeInner: 0.7,
    cornerOrnamentSize: 6,
    // White header + footer bands. The MME logo has a white PNG
    // background, so the header band gives it a clean letterhead zone
    // to sit on instead of clashing against cream. Footer band mirrors
    // the convention and gives the signature row + seal a clean canvas.
    headerBandHeight: 130,
    footerBandHeight: 172,
    // Inner content width — used to clamp ALL variable-length text so it
    // can never overflow the cert's printable area (the poster-cert
    // overflow caught in CEO/MD review 2026-06-01 was this exact bug:
    // a long abstract title concatenated into the recipient intro line
    // pushed text past the right border). Computed once, used everywhere.
    innerContentWidth: A4_PORTRAIT_W - 2 * 34 - 30, // borderInnerInset * 2 + breathing room
  },
  colors: {
    // Page background — warm cream/parchment.
    bgTop: "#fbf6e8",
    bgBottom: "#f5ecd2",
    // Header + footer bands — solid white at top and bottom of the page.
    // Two purposes: (1) the MME logo has a white PNG background so it
    // visually clashes against cream; the white band lets it blend
    // cleanly. (2) gives the cert a "letterhead" zoning convention —
    // top white band = identity, middle cream = body, bottom white
    // band = sign-off. Per CEO/MD review 2026-06-01.
    bandWhite: "#ffffff",
    // Soft cerulean rule at the edge between band and cream — separates
    // the zones without a hard line.
    bandRule: "#7bc9db",
    text: "#111111",
    muted: "#4a5568",
    soft: "#7a8499",
    // Title + body emphasis — deep navy for formality.
    title: "#1a2e5a",
    // Outer cert frame — navy.
    borderOuter: "#1a2e5a",
    // Inner + middle frame lines and all decorative ornaments — now
    // pale-cerulean shades instead of gold (CEO/MD feedback: "I do not
    // like the yellow color at all, maybe cerulean blue at 25% opacity").
    // Values are pre-blended hex (cerulean #00aade over cream bg) so we
    // get the visual effect of opacity without juggling doc.opacity()
    // save/restore around every stroke.
    //   ~25% cerulean → #c0e5ec   pale
    //   ~50% cerulean → #7bc9db   mid
    //   ~80% cerulean → #2baedc   saturated
    borderInner: "#7bc9db",
    borderMid: "#c0e5ec",
    // Corner-rosette centers get the FULL saturated cerulean — these
    // are focal-point ornaments that should read crisply. Petals stay
    // softer for hierarchy. The pop on the rosette centers is what
    // saves the corners from feeling washed-out against cream.
    cornerOrnament: "#00aade",
    cornerOrnamentPetal: "#7bc9db",
    dividerOrnament: "#7bc9db",
    // The strong-saturated cerulean — kept for the celebratory moments:
    // the "OF ATTENDANCE" subtitle, the "18 CPD Hours" number. Two-tier
    // cerulean hierarchy: pale shades for ornaments, strong for emphasis.
    cmeHighlight: "#00aade",
    // 0.025 sits just below text-legibility — the eye registers a
    // presence behind the content as "this paper has a watermark"
    // without the watermark competing with text legibility (the
    // 0.04 from the prior round was visible enough to read).
    watermarkOpacity: 0.025,
    // Accreditor panel — cream-on-cream callout with a pale-cerulean border.
    accreditorBoxBg: "#fffaee",
    accreditorBoxBorder: "#7bc9db",
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
    // Logo bumped 56→72 — diploma convention has a more prominent
    // identity mark at the top, and 56 read as timid against the
    // huge title below it. Aspect ratio preserved via pdfkit's
    // `fit: [w, h]` so we don't hardcode the logo's width.
    logoHeight: 72,
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
