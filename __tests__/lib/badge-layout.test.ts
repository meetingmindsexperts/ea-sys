/**
 * Badge geometry (Aug 25, 2026).
 *
 * The load-bearing property is the FIRST describe block: at the default size
 * every scale factor is exactly 1 and the origin is exactly where it has
 * always been, so this ships without moving a single existing badge. Every
 * organiser who has calibrated a printer against `badgeVerticalOffset` keeps
 * their calibration.
 */
import { describe, it, expect } from "vitest";
import {
  A4_W,
  BASE_BADGE_H,
  BASE_BADGE_W,
  BASE_TOP_MARGIN,
  DEFAULT_BADGE_LAYOUT,
  BASE_MARGIN,
  badgeScale,
  barcodeTooNarrow,
  barcodeWidthPt,
  mmToPt,
  ptToMm,
  readBadgeLayout,
  resolveBadgeOrigin,
  resolveBarcodeRow,
  badgeSerialTop,
  readBadgePolicy,
  DEFAULT_BADGE_POLICY,
  type BadgeLayout,
} from "@/lib/badge-layout";

describe("defaults reproduce the old hardcoded badge exactly", () => {
  it("an event with no badge settings resolves to 4x3 centred", () => {
    expect(readBadgeLayout({})).toEqual(DEFAULT_BADGE_LAYOUT);
  });

  it("scales are EXACTLY 1, not approximately", () => {
    // Approximately-1 would shift every interior element by a fraction of a
    // point and silently invalidate existing print calibration.
    const s = badgeScale(DEFAULT_BADGE_LAYOUT);
    expect(s).toEqual({ sx: 1, sy: 1, sf: 1 });
  });

  it("the origin is the same expression the route used to hardcode", () => {
    expect(resolveBadgeOrigin(DEFAULT_BADGE_LAYOUT)).toEqual({
      x: (A4_W - BASE_BADGE_W) / 2,
      y: BASE_TOP_MARGIN,
    });
  });

  it("the legacy badgeVerticalOffset column still moves the badge", () => {
    // Nobody's calibration is lost just because the new blob is absent.
    const layout = readBadgeLayout({ badgeVerticalOffset: 25 });
    expect(layout.offsetYPt).toBe(25);
    expect(resolveBadgeOrigin(layout).y).toBe(BASE_TOP_MARGIN + 25);
  });

  it("but the blob wins once an organiser saves", () => {
    const layout = readBadgeLayout({
      badgeVerticalOffset: 25,
      settings: { badge: { offsetYPt: -10 } },
    });
    expect(layout.offsetYPt).toBe(-10);
  });
});

describe("alignment on the A4 sheet", () => {
  const at = (align: string, widthPt = BASE_BADGE_W) =>
    resolveBadgeOrigin({ ...DEFAULT_BADGE_LAYOUT, widthPt, align: align as never }).x;

  it("left is flush to the page edge", () => {
    expect(at("left")).toBe(0);
  });

  it("right puts the badge's right edge on the page's right edge", () => {
    expect(at("right")).toBe(A4_W - BASE_BADGE_W);
    expect(at("right") + BASE_BADGE_W).toBeCloseTo(A4_W, 10);
  });

  it("centre leaves equal margins", () => {
    expect(at("center")).toBeCloseTo((A4_W - BASE_BADGE_W) / 2, 10);
  });

  it("alignment is computed against the ACTUAL width, not the default", () => {
    // The bug this pins: aligning a 200pt badge using the 288pt constant
    // would leave it 44pt off centre and hanging past the right edge.
    expect(at("center", 200)).toBeCloseTo((A4_W - 200) / 2, 10);
    expect(at("right", 200)).toBeCloseTo(A4_W - 200, 10);
  });

  it("the nudge is applied after alignment", () => {
    const x = resolveBadgeOrigin({ ...DEFAULT_BADGE_LAYOUT, align: "left", offsetXPt: 20 }).x;
    expect(x).toBe(20);
  });
});

describe("interior scaling", () => {
  it("fills the badge on each axis independently", () => {
    const s = badgeScale({ ...DEFAULT_BADGE_LAYOUT, widthPt: 576, heightPt: 216 });
    expect(s.sx).toBe(2);
    expect(s.sy).toBe(1);
  });

  it("sizes type on the SMALLER axis so it cannot overflow", () => {
    // A wide, short badge: doubling type to match the width would push the
    // bottom row and the DTCM band straight off the card.
    const s = badgeScale({ ...DEFAULT_BADGE_LAYOUT, widthPt: 576, heightPt: 216 });
    expect(s.sf).toBe(1);

    const tall = badgeScale({ ...DEFAULT_BADGE_LAYOUT, widthPt: 288, heightPt: 432 });
    expect(tall.sf).toBe(1);
  });

  it("shrinks everything on a smaller badge", () => {
    const s = badgeScale({ ...DEFAULT_BADGE_LAYOUT, widthPt: 144, heightPt: 108 });
    expect(s).toEqual({ sx: 0.5, sy: 0.5, sf: 0.5 });
  });
});

describe("defensive reads", () => {
  it("falls back per FIELD, not wholesale", () => {
    // One bad number must not take the other four down. A badge at the wrong
    // size is recoverable; a badge that fails to render stops the desk.
    const layout = readBadgeLayout({
      settings: { badge: { widthPt: "wide", heightPt: 300, align: "right" } },
    });
    expect(layout.widthPt).toBe(BASE_BADGE_W);
    expect(layout.heightPt).toBe(300);
    expect(layout.align).toBe("right");
  });

  it("rejects an unknown alignment rather than passing it through", () => {
    expect(readBadgeLayout({ settings: { badge: { align: "justify" } } }).align).toBe(
      "center",
    );
  });

  it("survives settings that are not an object", () => {
    for (const settings of [null, undefined, "x", 42, [], { badge: [] }, { badge: 7 }]) {
      expect(readBadgeLayout({ settings })).toEqual(DEFAULT_BADGE_LAYOUT);
    }
  });

  it("clamps a size that would render off the sheet", () => {
    const layout = readBadgeLayout({
      settings: { badge: { widthPt: 99999, heightPt: 1 } },
    });
    expect(layout.widthPt).toBe(A4_W);
    expect(layout.heightPt).toBe(80);
  });

  it("clamps the nudge to the range the vertical offset always had", () => {
    const layout = readBadgeLayout({
      settings: { badge: { offsetXPt: 5000, offsetYPt: -5000 } },
    });
    expect(layout.offsetXPt).toBe(200);
    expect(layout.offsetYPt).toBe(-200);
  });

  it("ignores NaN and Infinity, which JSON.parse can produce via strings", () => {
    const layout = readBadgeLayout({
      settings: { badge: { widthPt: NaN, heightPt: Infinity } },
    });
    expect(layout.widthPt).toBe(BASE_BADGE_W);
    expect(layout.heightPt).toBe(BASE_BADGE_H);
  });
});

describe("unit conversion for the settings form", () => {
  it("round-trips millimetres", () => {
    expect(ptToMm(mmToPt(101.6))).toBeCloseTo(101.6, 6);
  });

  it("agrees with the known stock size the defaults came from", () => {
    // 4" x 3" is 101.6mm x 76.2mm. If this drifts, the form is lying about
    // what size the organiser is choosing.
    expect(ptToMm(BASE_BADGE_W)).toBeCloseTo(101.6, 1);
    expect(ptToMm(BASE_BADGE_H)).toBeCloseTo(76.2, 1);
  });
});

describe("the settings form round-trip preserves exactness", () => {
  // Found in the browser, not by a test: the form works in millimetres, so
  // 288pt renders as 101.6mm and converts back to 287.9999998185827. That is
  // visually identical and quietly fatal — badgeScale returns 0.99999999
  // instead of 1, every interior offset shifts by a fraction of a point, and
  // the promise that an untouched event prints what it always printed is gone.
  //
  // Every other test in this file builds a layout object directly and never
  // passes through the form, which is exactly why none of them caught it.

  it("the default badge survives a points -> mm -> points trip exactly", () => {
    expect(mmToPt(ptToMm(BASE_BADGE_W))).toBe(BASE_BADGE_W);
    expect(mmToPt(ptToMm(BASE_BADGE_H))).toBe(BASE_BADGE_H);
  });

  it("and the form's rounded display value still lands on exact points", () => {
    // The form shows one decimal place, so this is the number a real organiser
    // actually submits.
    const shown = (pt: number) => Math.round(ptToMm(pt) * 10) / 10;
    expect(mmToPt(shown(BASE_BADGE_W))).toBe(BASE_BADGE_W);
    expect(mmToPt(shown(BASE_BADGE_H))).toBe(BASE_BADGE_H);
  });

  it("so a layout saved from an untouched form still scales by exactly 1", () => {
    // The property the whole no-regression guarantee rests on.
    const layout = readBadgeLayout({
      settings: {
        badge: {
          widthPt: mmToPt(101.6),
          heightPt: mmToPt(76.2),
        },
      },
    });
    expect(badgeScale(layout)).toEqual({ sx: 1, sy: 1, sf: 1 });
  });
});

describe("barcode scannability warning", () => {
  // Desk staff scan the BADGE for attendance, so the barcode is the credential
  // and an unreadable one is a queue at the door. Shrinking the badge shrinks
  // the bars with it, and nothing used to say so.
  const at = (widthPt: number, barcode = true): BadgeLayout => ({
    ...DEFAULT_BADGE_LAYOUT,
    widthPt,
    fields: { ...DEFAULT_BADGE_LAYOUT.fields, barcode },
  });

  it("reads the same width the renderer actually draws", () => {
    // Derived from the renderer's own expression, not re-estimated. If these
    // drift, the warning starts lying in one direction or the other.
    const w = barcodeWidthPt(DEFAULT_BADGE_LAYOUT);
    expect(w).toBe(BASE_BADGE_W - BASE_MARGIN * 2 - 20);
    expect(ptToMm(w)).toBeCloseTo(80.4, 1);
  });

  it("does not warn on the default 4-inch badge", () => {
    expect(barcodeTooNarrow(DEFAULT_BADGE_LAYOUT)).toBe(false);
  });

  it("warns once the badge is too narrow to carry readable bars", () => {
    expect(barcodeTooNarrow(at(180))).toBe(true);
  });

  it("never warns when the barcode is switched off", () => {
    // An overprinted badge with no barcode has nothing to be unreadable.
    expect(barcodeTooNarrow(at(120, false))).toBe(false);
  });

  it("the threshold sits below the smallest common stock, not above it", () => {
    // 3.5" x 2.25" is a real badge size an organiser can pick from the
    // presets. If the warning fired on a preset it would be noise.
    expect(barcodeTooNarrow(at(mmToPt(88.9)))).toBe(false);
  });
});

describe("barcode / DTCM QR arrangement", () => {
  const sideBySide: BadgeLayout = {
    ...DEFAULT_BADGE_LAYOUT,
    barcodeArrangement: "side-by-side",
  };

  it("defaults to the historical stacked layout", () => {
    // Anything else would silently re-print every existing event's badge the
    // moment this shipped.
    expect(DEFAULT_BADGE_LAYOUT.barcodeArrangement).toBe("stacked");
    expect(readBadgeLayout({}).barcodeArrangement).toBe("stacked");
  });

  it("a corrupt or unknown value falls back to stacked, not to nothing", () => {
    // Same direction as every other reader here: a badge that prints as it
    // always did is recoverable; one that rearranges itself is a reprint.
    for (const bad of ["sidebyside", "", 1, null, {}, ["side-by-side"]]) {
      expect(
        readBadgeLayout({ settings: { badge: { barcodeArrangement: bad } } })
          .barcodeArrangement,
      ).toBe("stacked");
    }
  });

  it("round-trips a valid arrangement off the settings blob", () => {
    expect(
      readBadgeLayout({ settings: { badge: { barcodeArrangement: "side-by-side" } } })
        .barcodeArrangement,
    ).toBe("side-by-side");
  });

  it("stacked draws the QR in its own band BELOW the barcode", () => {
    const row = resolveBarcodeRow(DEFAULT_BADGE_LAYOUT, true);
    expect(row.qrDy).toBeGreaterThan(row.barcodeDy + row.barcodeH);
    // Full content width — the QR is not in the barcode's way.
    expect(row.barcodeW).toBe(BASE_BADGE_W - BASE_MARGIN * 2 - 20);
  });

  it("side-by-side puts them on ONE row and narrows the barcode", () => {
    const row = resolveBarcodeRow(sideBySide, true);
    const stacked = resolveBarcodeRow(DEFAULT_BADGE_LAYOUT, true);

    // Vertically overlapping, i.e. actually beside each other.
    expect(row.qrDy).toBeGreaterThanOrEqual(row.barcodeDy);
    expect(row.qrDy).toBeLessThan(row.barcodeDy + row.barcodeH);
    // And the barcode gave up exactly the QR plus the gap.
    expect(row.barcodeW).toBeLessThan(stacked.barcodeW);
    expect(stacked.barcodeW - row.barcodeW).toBe(row.qrSize + 8);
    // Never overlapping horizontally.
    expect(row.barcodeDx + row.barcodeW).toBeLessThanOrEqual(row.qrDx);
  });

  it("side-by-side changes NOTHING when no QR will be drawn", () => {
    // A flagged event still prints full-width bars for a registration whose
    // code was never imported, or whose QR failed to rasterise. Narrowing the
    // barcode to reserve empty space would cost scannability for nothing.
    expect(resolveBarcodeRow(sideBySide, false)).toEqual(
      resolveBarcodeRow(DEFAULT_BADGE_LAYOUT, false),
    );
  });

  it("stacked CENTRES the QR; side-by-side flushes it right", () => {
    // Owner, Aug 25 2026, superseding this file's original assertion that the
    // QR sits flush right in BOTH arrangements. That was defended on the
    // grounds that it should not appear to jump when the setting is flipped,
    // which does not survive contact with the two layouts: stacked is a column
    // of centred symbols, so a QR hanging off one edge reads as misaligned.
    const stacked = resolveBarcodeRow(DEFAULT_BADGE_LAYOUT, true);
    const centre = (BASE_BADGE_W - stacked.qrSize) / 2;
    expect(stacked.qrDx).toBeCloseTo(centre, 5);

    const beside = resolveBarcodeRow(sideBySide, true);
    expect(beside.qrDx).toBe(BASE_BADGE_W - BASE_MARGIN - beside.qrSize);
    expect(beside.qrDx).toBeGreaterThan(stacked.qrDx);
  });

  it("the stacked barcode and QR share the same centre line", () => {
    // The point of the change: the column reads as a column.
    const row = resolveBarcodeRow(DEFAULT_BADGE_LAYOUT, true);
    expect(row.barcodeDx + row.barcodeW / 2).toBeCloseTo(row.qrDx + row.qrSize / 2, 5);
  });

  it("costs the barcode the QR plus the gap, NOT half the width", () => {
    // Worth stating as a number, because "side by side halves the barcode" is
    // the intuitive guess and it is wrong: the QR is 40pt square, so a default
    // 4in badge goes from ~80mm of bars to ~64mm, which is still above the
    // ~60mm a desk scanner wants. The cost is real but small.
    expect(ptToMm(barcodeWidthPt(DEFAULT_BADGE_LAYOUT, true))).toBeCloseTo(80.4, 1);
    expect(ptToMm(barcodeWidthPt(sideBySide, true))).toBeCloseTo(63.5, 1);
  });

  it("the width warning follows the arrangement", () => {
    // The default 4in badge survives side-by-side with ~3mm to spare. The
    // arrangement matters at sizes where stacked is still fine and side by
    // side is not — that band is exactly what the warning exists to catch.
    const narrow = (l: BadgeLayout): BadgeLayout => ({ ...l, widthPt: mmToPt(95) });

    expect(barcodeTooNarrow(DEFAULT_BADGE_LAYOUT, true)).toBe(false);
    expect(barcodeTooNarrow(sideBySide, true)).toBe(false);

    expect(barcodeTooNarrow(narrow(DEFAULT_BADGE_LAYOUT), true)).toBe(false);
    expect(barcodeTooNarrow(narrow(sideBySide), true)).toBe(true);
  });

  it("the warning does NOT fire on an event that prints no QR", () => {
    // A warning that fires when it should not is one an organiser learns to
    // scroll past.
    expect(barcodeTooNarrow(sideBySide, false)).toBe(false);
  });

  it("a badge too narrow to hold both clamps the barcode at zero", () => {
    const tiny: BadgeLayout = { ...sideBySide, widthPt: 80 };
    expect(resolveBarcodeRow(tiny, true).barcodeW).toBeGreaterThanOrEqual(0);
  });
});

describe("registration number moved under the name", () => {
  it("prints between the name and the organisation / country band", () => {
    // Owner, Aug 25 2026. It used to sit flush left on the bottom row opposite
    // the role; it identifies the person, so it belongs with their name.
    // The name occupies roughly 30..52 at 18pt and the org/country band is at
    // +72, so it has to land between them or it collides with one of them.
    const top = badgeSerialTop(1);
    expect(top).toBeGreaterThan(52);
    expect(top + 10).toBeLessThan(72);
  });

  it("scales with the badge like every other interior offset", () => {
    expect(badgeSerialTop(2)).toBe(badgeSerialTop(1) * 2);
    // Exactly 1 at the default size, so the multiply is a no-op there.
    expect(badgeSerialTop(1)).toBe(58);
  });
});

describe("badge policy — kiosk reprint", () => {
  it("is OFF unless explicitly and correctly set to boolean true", () => {
    // Strict for the same reason every credential-adjacent flag here is
    // strict: handing out a second physical badge because a JSON blob was
    // malformed is not recoverable by fixing the blob afterwards.
    expect(readBadgePolicy(undefined).allowKioskReprint).toBe(false);
    expect(readBadgePolicy(null).allowKioskReprint).toBe(false);
    expect(readBadgePolicy({}).allowKioskReprint).toBe(false);
    expect(readBadgePolicy({ badge: {} }).allowKioskReprint).toBe(false);
    expect(readBadgePolicy({ badge: null }).allowKioskReprint).toBe(false);
    expect(readBadgePolicy([]).allowKioskReprint).toBe(false);
    for (const truthy of ["true", 1, "yes", {}]) {
      expect(readBadgePolicy({ badge: { allowKioskReprint: truthy } }).allowKioskReprint).toBe(false);
    }
  });

  it("reads a real opt-in", () => {
    expect(readBadgePolicy({ badge: { allowKioskReprint: true } }).allowKioskReprint).toBe(true);
  });

  it("is read separately from the geometry", () => {
    // Deliberately not a field on BadgeLayout: that object goes to the PDF
    // renderer, which has no business knowing about reprints.
    expect("allowKioskReprint" in DEFAULT_BADGE_LAYOUT).toBe(false);
    expect(DEFAULT_BADGE_POLICY).toEqual({ allowKioskReprint: false });
  });
});
