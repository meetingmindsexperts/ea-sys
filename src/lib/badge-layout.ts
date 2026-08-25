/**
 * Badge geometry: how big the badge is, and where it sits on the A4 sheet.
 *
 * WHY THIS EXISTS. Until Aug 25 2026 the badge was a fixed 288x216pt block
 * (4"x3") hard-centred on the page, with exactly one organiser control:
 * `Event.badgeVerticalOffset`. That is fine for one tenant who standardised on
 * one stock. It is unusable for a second tenant whose badge holders are a
 * different size, and no amount of *alignment* fixes that, because alignment
 * only matters when you are printing onto pre-cut stock and stock size is
 * exactly the thing that varies.
 *
 * WHERE IT IS STORED. `Event.settings.badge`, not new columns. The house
 * pattern for feature config is the settings blob (`settings.webinar`,
 * `settings.sponsors`, `settings.abstractLimits`, `settings.groupRegistration`),
 * it needs no migration, and `updateEventSettings` already gives an atomic
 * locked merge so a concurrent writer cannot clobber it.
 *
 * The legacy `badgeVerticalOffset` COLUMN is folded in here on read rather
 * than left as a second source of truth. `readBadgeLayout` is the only place
 * that resolves it, so the two cannot drift: the column is the fallback, the
 * blob wins once an organiser saves.
 *
 * UNITS. Sizes are stored in POINTS, the unit pdfkit draws in, so nothing is
 * converted at render time. The UI presents millimetres, because print stock
 * is quoted in mm everywhere outside the US. Offsets stay in POINTS because
 * `badgeVerticalOffset` has always been points and someone has already
 * calibrated a printer against that number — silently reinterpreting it as mm
 * would move every existing badge by a factor of 2.8.
 */

/** The original hardcoded badge. Every default below reproduces it exactly. */
export const BASE_BADGE_W = 288; // 4 inches
export const BASE_BADGE_H = 216; // 3 inches

/** A4 in points. */
export const A4_W = 595.28;
export const A4_H = 841.89;

/** Default distance from the top of the sheet, before the organiser's nudge. */
export const BASE_TOP_MARGIN = 36; // 0.5 inch

/** Interior padding at the base size. Scales with the badge. */
export const BASE_MARGIN = 20;

export type BadgeAlign = "left" | "center" | "right";

/**
 * How the entry barcode and the DTCM compliance QR share the badge.
 *
 * `stacked` is how the badge has always printed: the barcode spans the full
 * content width in its own band, and the QR sits in a separate band below the
 * bottom row. `side-by-side` puts them on one row, which reclaims the vertical
 * space the QR band costs on a short badge.
 *
 * The trade is real and the settings card says so, with the measured number
 * rather than the intuitive one: the QR is 40pt square plus an 8pt gap, so a
 * default 4in badge goes from ~80mm of bars to ~64mm. That is a cost, not a
 * halving, and it still clears the ~60mm a desk scanner wants — but a badge
 * already narrower than about 98mm crosses the line (MIN_SCANNABLE_BARCODE_PT).
 * The organiser is warned, never blocked.
 *
 * It only changes anything when a QR is ACTUALLY drawn, i.e. a DTCM-flagged
 * event and a registration that has an imported code. Everything else keeps
 * the full-width barcode, so a batch is not needlessly narrowed for a symbol
 * that is not there.
 */
export type BadgeBarcodeArrangement = "stacked" | "side-by-side";

/**
 * Interior geometry for the barcode row, in BASE points (288x216).
 *
 * Named constants rather than literals buried in the renderer because the
 * "too narrow to scan" warning has to compute the same widths. See
 * `resolveBarcodeRow`.
 */
const BARCODE_BAND_TOP = 95;
const BARCODE_BAND_H = 40;
/** Inset the barcode gets on each side, inside the content width. */
const BARCODE_INSET = 10;
/** Top of the QR band in `stacked` — below the bottom row, so nothing moves. */
const DTCM_BAND_TOP = 172;
/** Square. approx 14mm at base size: QR v3 modules approx 0.48mm, scannable. */
const DTCM_QR_SIDE = 40;
/** Breathing room between the two symbols when they share a row. */
const BARCODE_QR_GAP = 8;

/**
 * Which elements print.
 *
 * WHY THIS IS NEEDED, and it is not the case the original renderer imagined.
 * The real-world workflow is OVERPRINTING: a designer supplies pre-printed
 * stock carrying the event branding, sponsor logos and any QR codes, and we
 * print only the personalisation into a fixed blank window. A live MM Group
 * badge (UAE Rare Disease Congress 2025) carries exactly three lines from us —
 * name, organisation, role — and none of the country, entry barcode,
 * registration number or compliance QR the renderer draws by default.
 *
 * The border matters most of all: on overprinted stock a dashed grey rectangle
 * lands across someone's finished design.
 *
 * Every flag defaults to TRUE, reproducing the badge as it has always printed,
 * so this is opt-out per event and no existing event changes.
 */
export interface BadgeFields {
  /** Dashed cutting guide. Turn OFF when overprinting pre-printed stock. */
  border: boolean;
  name: boolean;
  /** Employer / institution. Absent from the original renderer entirely. */
  organization: boolean;
  country: boolean;
  barcode: boolean;
  registrationNumber: boolean;
  badgeType: boolean;
}

export const DEFAULT_BADGE_FIELDS: BadgeFields = {
  border: true,
  name: true,
  // The one field that defaults OFF: it has never rendered, so switching it on
  // for everyone would silently change every existing event's badge.
  organization: false,
  country: true,
  barcode: true,
  registrationNumber: true,
  badgeType: true,
};

export interface BadgeLayout {
  widthPt: number;
  heightPt: number;
  align: BadgeAlign;
  /** Nudge, in points, applied after alignment. Negative moves left/up. */
  offsetXPt: number;
  offsetYPt: number;
  /** Entry barcode vs DTCM QR placement. Defaults to the historical layout. */
  barcodeArrangement: BadgeBarcodeArrangement;
  fields: BadgeFields;
}

export const DEFAULT_BADGE_LAYOUT: BadgeLayout = {
  widthPt: BASE_BADGE_W,
  heightPt: BASE_BADGE_H,
  align: "center",
  offsetXPt: 0,
  offsetYPt: 0,
  // The historical layout. Anything else would silently re-print every
  // existing event's badge the moment this shipped.
  barcodeArrangement: "stacked",
  fields: DEFAULT_BADGE_FIELDS,
};

/** Per-field read, so one bad key cannot switch off the whole badge. */
function readFields(raw: unknown): BadgeFields {
  const blob =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const flag = (k: keyof BadgeFields): boolean =>
    typeof blob[k] === "boolean" ? (blob[k] as boolean) : DEFAULT_BADGE_FIELDS[k];

  return {
    border: flag("border"),
    name: flag("name"),
    organization: flag("organization"),
    country: flag("country"),
    barcode: flag("barcode"),
    registrationNumber: flag("registrationNumber"),
    badgeType: flag("badgeType"),
  };
}

/**
 * Bounds. Width and height are capped to the sheet so a typo cannot produce a
 * badge that renders off-page; offsets keep the +/-200pt range the vertical
 * offset has always had, which is ~70mm of travel in each direction.
 */
const MIN_SIDE_PT = 80; // ~28mm — below this the barcode stops being scannable
const MAX_OFFSET_PT = 200;

const ALIGNMENTS: readonly BadgeAlign[] = ["left", "center", "right"];
const ARRANGEMENTS: readonly BadgeBarcodeArrangement[] = ["stacked", "side-by-side"];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Resolve the effective layout for an event.
 *
 * Defensive by construction: a corrupt or partial `settings.badge` falls back
 * per FIELD, not wholesale, so one bad number cannot take the other four down
 * (the `readAbstractLimits` rule). A badge that renders at the default size is
 * a recoverable annoyance; one that fails to render stops the desk.
 */
export function readBadgeLayout(event: {
  settings?: unknown;
  badgeVerticalOffset?: number | null;
}): BadgeLayout {
  const settings = event.settings;
  const raw =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).badge
      : null;
  const blob =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const align = ALIGNMENTS.includes(blob.align as BadgeAlign)
    ? (blob.align as BadgeAlign)
    : DEFAULT_BADGE_LAYOUT.align;

  // Anything that is not exactly one of the two known strings resolves to the
  // historical layout. Same direction as every other reader here: a badge that
  // prints as it always did is a recoverable annoyance, one that rearranges
  // itself because a key got corrupted is a reprint of the whole batch.
  const barcodeArrangement = ARRANGEMENTS.includes(blob.barcodeArrangement as BadgeBarcodeArrangement)
    ? (blob.barcodeArrangement as BadgeBarcodeArrangement)
    : DEFAULT_BADGE_LAYOUT.barcodeArrangement;

  // The legacy column is the fallback for the vertical nudge ONLY, and only
  // until an organiser saves the new form. One reader, so no drift.
  const legacyOffsetY = num(event.badgeVerticalOffset) ?? 0;

  return {
    widthPt: clamp(num(blob.widthPt) ?? BASE_BADGE_W, MIN_SIDE_PT, A4_W),
    heightPt: clamp(num(blob.heightPt) ?? BASE_BADGE_H, MIN_SIDE_PT, A4_H),
    align,
    offsetXPt: clamp(num(blob.offsetXPt) ?? 0, -MAX_OFFSET_PT, MAX_OFFSET_PT),
    offsetYPt: clamp(
      num(blob.offsetYPt) ?? legacyOffsetY,
      -MAX_OFFSET_PT,
      MAX_OFFSET_PT,
    ),
    barcodeArrangement,
    fields: readFields(blob.fields),
  };
}

/**
 * Top-left corner of the badge on the sheet.
 *
 * `left` and `right` mean flush to the page edge, which is what "align to the
 * A4 page" says. Most printers cannot image within ~5mm of the edge, so the
 * nudge exists to pull it back in; the UI says so and the preview shows it.
 * Choosing a hidden safety margin instead would mean "left" quietly did not
 * mean left, which is worse than a clipped preview that explains itself.
 */
export function resolveBadgeOrigin(layout: BadgeLayout): { x: number; y: number } {
  const alignX =
    layout.align === "left"
      ? 0
      : layout.align === "right"
        ? A4_W - layout.widthPt
        : (A4_W - layout.widthPt) / 2;

  return {
    x: alignX + layout.offsetXPt,
    y: BASE_TOP_MARGIN + layout.offsetYPt,
  };
}

/**
 * How to scale the interior, which is laid out against absolute offsets from
 * the badge's top-left (name at +30, barcode at +95, the bottom row at +145,
 * the DTCM band at +172) and was tuned for 288x216.
 *
 * Positions scale on their own axis so the content fills the badge. FONTS and
 * images scale on the SMALLER of the two, so a badge that is wide and short
 * cannot push 20pt type off the bottom. At the default size all three are
 * exactly 1, which is what makes this change invisible to every existing
 * event: multiplying by 1 returns the identical number, not a near one.
 */
export interface BadgeScale {
  sx: number;
  sy: number;
  /** For type sizes, image fits and margins. */
  sf: number;
}

export function badgeScale(layout: BadgeLayout): BadgeScale {
  const sx = layout.widthPt / BASE_BADGE_W;
  const sy = layout.heightPt / BASE_BADGE_H;
  return { sx, sy, sf: Math.min(sx, sy) };
}

/** Points to millimetres, for the settings UI. */
export const ptToMm = (pt: number): number => pt * 0.352777778;

/**
 * Millimetres to points, ROUNDED to 1/100th of a point.
 *
 * The rounding is load-bearing, not tidiness. The settings form works in mm,
 * so the default 4" badge round-trips as 101.6mm -> 287.9999998185827pt. That
 * is visually identical and quietly fatal: `badgeScale` would return
 * 0.99999999 instead of 1, every interior offset would shift by a fraction of
 * a point, and the guarantee that an untouched event prints exactly what it
 * always printed would be gone. The unit tests could not see it because they
 * build layouts directly and never pass through the form.
 *
 * 0.01pt is 0.0035mm, far below what any printer resolves.
 */
export const mmToPt = (mm: number): number => Math.round((mm / 0.352777778) * 100) / 100;

/**
 * Where the entry barcode and the DTCM QR sit inside the badge, as offsets
 * from the badge's top-left corner.
 *
 * ONE function, because the renderer draws these and the "too narrow to scan"
 * warning has to predict them. Before this, the warning re-stated the
 * renderer's width expression in a second place under a comment asking the
 * next person to keep them in sync, which is precisely the shape that drifts —
 * and a warning that has drifted from the renderer is worse than no warning,
 * because it tells the organiser their badge is fine when it is not.
 *
 * `hasDtcm` means "a QR will actually be drawn on THIS badge", not "this event
 * collects DTCM codes". A flagged event still prints full-width bars for a
 * registration whose code was never imported, and for one whose QR failed to
 * rasterise, because narrowing the barcode to make room for a symbol that is
 * not there costs scannability for nothing.
 */
export interface BarcodeRowGeometry {
  /** Offsets from the badge origin, in points. */
  barcodeDx: number;
  barcodeDy: number;
  barcodeW: number;
  barcodeH: number;
  qrDx: number;
  qrDy: number;
  qrSize: number;
}

export function resolveBarcodeRow(
  layout: BadgeLayout,
  hasDtcm: boolean,
): BarcodeRowGeometry {
  const { sx, sy, sf } = badgeScale(layout);
  const margin = BASE_MARGIN * sf;
  const contentW = layout.widthPt - margin * 2;

  const barcodeDx = margin + BARCODE_INSET * sx;
  const barcodeDy = BARCODE_BAND_TOP * sy;
  const barcodeH = BARCODE_BAND_H * sy;
  const fullW = contentW - BARCODE_INSET * 2 * sx;

  const qrSize = DTCM_QR_SIDE * sf;
  // Flush to the right edge of the content area in BOTH arrangements, so the
  // QR does not appear to jump sideways when the organiser flips the setting.
  const qrDx = layout.widthPt - margin - qrSize;

  if (layout.barcodeArrangement !== "side-by-side" || !hasDtcm) {
    return {
      barcodeDx,
      barcodeDy,
      barcodeW: fullW,
      barcodeH,
      qrDx,
      qrDy: DTCM_BAND_TOP * sy,
      qrSize,
    };
  }

  return {
    barcodeDx,
    barcodeDy,
    // Never negative: a badge narrow enough for the QR to eat the whole row
    // clamps to zero rather than asking pdfkit to fit a negative box.
    barcodeW: Math.max(0, fullW - qrSize - BARCODE_QR_GAP * sx),
    barcodeH,
    qrDx,
    // Centred against the barcode band so the two read as one row rather than
    // as a symbol with something floating beside it.
    qrDy: barcodeDy + (barcodeH - qrSize) / 2,
    qrSize,
  };
}

/**
 * Printed width of the entry barcode, in points.
 *
 * Derived from `resolveBarcodeRow`, the same function the renderer draws with.
 *
 * `hasDtcm` defaults to false so the historical question ("how wide are the
 * bars on an ordinary badge?") is still one argument, and so the answer for a
 * stacked layout is unchanged whatever is passed.
 */
export function barcodeWidthPt(layout: BadgeLayout, hasDtcm = false): number {
  return resolveBarcodeRow(layout, hasDtcm).barcodeW;
}

/**
 * Below roughly 60mm the bars get too fine for a desk scanner to read
 * reliably.
 *
 * The reasoning, so the number is arguable rather than magic: the encoded
 * value is `{qrCode}-{serial}`, around 18 characters, which is about 233
 * Code 128 modules once you count the start, checksum and stop patterns. The
 * usual guidance for a reliable X-dimension is 0.25mm per module, and
 * 233 x 0.25mm is about 58mm. The default 4" badge gives about 80mm, so it
 * has comfortable headroom; a badge much under 76mm wide does not — and a
 * side-by-side arrangement roughly halves whatever is available.
 *
 * This is a WARNING, never a block. An organiser who prints a test badge and
 * finds it scans fine on their hardware knows more than this constant does.
 */
export const MIN_SCANNABLE_BARCODE_PT = 170; // ~60mm

export function barcodeTooNarrow(layout: BadgeLayout, hasDtcm = false): boolean {
  return (
    layout.fields.barcode &&
    barcodeWidthPt(layout, hasDtcm) < MIN_SCANNABLE_BARCODE_PT
  );
}
