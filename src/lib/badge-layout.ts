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

export type BadgeAlign = "left" | "center" | "right";

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
  fields: BadgeFields;
}

export const DEFAULT_BADGE_LAYOUT: BadgeLayout = {
  widthPt: BASE_BADGE_W,
  heightPt: BASE_BADGE_H,
  align: "center",
  offsetXPt: 0,
  offsetYPt: 0,
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
