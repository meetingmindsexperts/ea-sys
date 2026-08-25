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
  badgeScale,
  mmToPt,
  ptToMm,
  readBadgeLayout,
  resolveBadgeOrigin,
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
