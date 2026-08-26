/**
 * Badge rendering (Aug 25, 2026).
 *
 * The interior was laid out against absolute offsets tuned for a 288x216pt
 * card. Making the size organiser-controlled means multiplying every one of
 * them, and the risk that carries is subtle: every existing event has a
 * printer calibrated against the old coordinates, so a change that moves a
 * badge by two points is invisible in review and expensive on event morning.
 *
 * So the load-bearing test is the first one — at the default size the name
 * lands on exactly the coordinates the old hardcoded renderer used.
 *
 * TESTING NOTE. Asserting on the finished PDF's text does not work: pdfkit
 * Flate-compresses its content streams and subsets the font, so the words are
 * glyph indices and a `pdf.includes("DELEGATE")` check is false for text that
 * is plainly on the page. This spies on `PDFDocument.prototype` with
 * call-through instead, the same approach receipt-pdf-masthead.test.ts uses,
 * so pdfkit still genuinely renders while the geometry stays observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PDFDocument from "pdfkit";
vi.mock("@/lib/barcode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/barcode")>();
  return {
    ...actual,
    // Call-through: pdfkit still receives a real PNG, so the image-drawing
    // assertions elsewhere stay meaningful.
    renderBarcodePng: vi.fn(actual.renderBarcodePng),
    renderQrPng: vi.fn(actual.renderQrPng),
  };
});

import { renderBarcodePng } from "@/lib/barcode";
import { generateBadgePDF, type BadgeRegistration } from "@/lib/badge-pdf";
import {
  A4_W,
  BASE_BADGE_H,
  BASE_BADGE_W,
  BASE_TOP_MARGIN,
  DEFAULT_BADGE_LAYOUT,
  type BadgeLayout,
} from "@/lib/badge-layout";

const REG: BadgeRegistration = {
  id: "r1",
  serialId: 7,
  qrCode: "ABCDEF123456",
  dtcmBarcode: null,
  badgeType: "DELEGATE",
  attendee: {
    firstName: "Jane",
    lastName: "Doe",
    country: "United Arab Emirates",
    organization: "Meeting Minds Experts",
  },
};

type TextCall = { str: string; x: number; y: number };
type RectCall = { x: number; y: number; w: number; h: number };

let textCalls: TextCall[];
let rectCalls: RectCall[];
let fontSizes: number[];

beforeEach(() => {
  textCalls = [];
  rectCalls = [];
  fontSizes = [];

  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const [str, x, y] = args as [string, number, number];
    if (typeof x === "number" && typeof y === "number") {
      textCalls.push({ str: String(str), x, y });
    }
    return this as never;
  });

  vi.spyOn(PDFDocument.prototype, "rect").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const [x, y, w, h] = args as [number, number, number, number];
    rectCalls.push({ x, y, w, h });
    return this as never;
  });

  const realFontSize = PDFDocument.prototype.fontSize;
  vi.spyOn(PDFDocument.prototype, "fontSize").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const size = args[0] as number;
    fontSizes.push(size);
    // Call through: pdfkit must still lay the text out for real, or the
    // coordinates the other assertions read would be meaningless.
    return realFontSize.call(this as never, size);
  });
});

afterEach(() => {
  // NOT restoreAllMocks: that would strip the module-level `@/lib/barcode`
  // call-through spy and the next test would rasterize nothing.
  vi.restoreAllMocks();
});

const render = (layout: BadgeLayout = DEFAULT_BADGE_LAYOUT, reg = REG) =>
  generateBadgePDF([reg], layout, false);

const find = (needle: string) => textCalls.find((c) => c.str.includes(needle));

/** The badge frame. Asserts it was drawn, so "nothing rendered" fails loudly. */
const frame = (): RectCall => {
  const r = rectCalls[0];
  expect(r).toBeDefined();
  return r as RectCall;
};

describe("the default size reproduces the old hardcoded coordinates", () => {
  it("draws the name where the previous renderer drew it", async () => {
    await render();

    // The old code: x = (A4_W - BADGE_W) / 2, y = 36, name at (x + 20, y + 30).
    const expectedX = (A4_W - BASE_BADGE_W) / 2;
    const name = find("Jane Doe");
    expect(name).toBeDefined();
    expect(name!.x).toBeCloseTo(expectedX + 20, 10);
    expect(name!.y).toBeCloseTo(BASE_TOP_MARGIN + 30, 10);
  });

  it("draws the badge frame at the historical size and position", async () => {
    await render();
    const f = frame();
    expect(f.w).toBe(BASE_BADGE_W);
    expect(f.h).toBe(BASE_BADGE_H);
    expect(f.x).toBeCloseTo((A4_W - BASE_BADGE_W) / 2, 10);
    expect(f.y).toBe(BASE_TOP_MARGIN);
  });

  it("keeps the historical type sizes exactly, not approximately", async () => {
    await render();
    // Name 18, country 10, registration number 10, badge type 20.
    expect(fontSizes).toContain(18);
    expect(fontSizes).toContain(20);
    expect(fontSizes).toContain(10);
  });

  it("still honours the legacy vertical offset", async () => {
    await render({ ...DEFAULT_BADGE_LAYOUT, offsetYPt: 15 });
    expect(frame().y).toBe(BASE_TOP_MARGIN + 15);
  });
});

describe("alignment moves the badge on the sheet", () => {
  it("left puts the frame at the page edge", async () => {
    await render({ ...DEFAULT_BADGE_LAYOUT, align: "left" });
    expect(frame().x).toBe(0);
  });

  it("right puts the frame's far edge on the page's far edge", async () => {
    await render({ ...DEFAULT_BADGE_LAYOUT, align: "right" });
    expect(frame().x + BASE_BADGE_W).toBeCloseTo(A4_W, 10);
  });

  it("the interior travels with the frame", async () => {
    // The bug this pins: aligning the frame while leaving the contents at
    // their old absolute x would print a bordered rectangle with the name
    // floating somewhere else on the sheet.
    await render({ ...DEFAULT_BADGE_LAYOUT, align: "left" });
    expect(find("Jane Doe")!.x).toBeCloseTo(20, 10);
  });
});

describe("the interior scales with the badge", () => {
  it("halving the badge halves the offsets and the type", async () => {
    await render({
      ...DEFAULT_BADGE_LAYOUT,
      widthPt: BASE_BADGE_W / 2,
      heightPt: BASE_BADGE_H / 2,
      align: "left",
    });
    const name = find("Jane Doe")!;
    expect(name.x).toBeCloseTo(10, 10); // margin 20 * 0.5
    expect(name.y).toBeCloseTo(BASE_TOP_MARGIN + 15, 10); // 30 * 0.5
    expect(fontSizes).toContain(9); // 18 * 0.5
  });

  it("a wide short badge does not grow the type past the card", async () => {
    // Type scales on the SMALLER axis. Scaling it to the width here would
    // double every font and push the bottom row off a card that got no taller.
    await render({
      ...DEFAULT_BADGE_LAYOUT,
      widthPt: BASE_BADGE_W * 2,
      heightPt: BASE_BADGE_H,
      align: "left",
    });
    expect(fontSizes).toContain(18);
    expect(fontSizes).not.toContain(36);
  });

  it("every element stays inside the badge at a small size", async () => {
    const layout: BadgeLayout = {
      ...DEFAULT_BADGE_LAYOUT,
      widthPt: 160,
      heightPt: 120,
      align: "left",
    };
    await render(layout);
    const f = frame();
    for (const call of textCalls) {
      expect(call.x).toBeGreaterThanOrEqual(f.x);
      expect(call.y).toBeGreaterThanOrEqual(f.y);
      // The bottom row sits at 145/216 of the height; nothing may pass the edge.
      expect(call.y).toBeLessThan(f.y + layout.heightPt);
    }
  });
});

describe("field visibility, for overprinting pre-printed stock", () => {
  // The live MM Group badge (UAE Rare Disease Congress 2025) is pre-printed
  // stock: branding, sponsor logos and app QRs are already on the card, and we
  // print three lines into a blank window. Everything else we draw would land
  // on top of someone's finished design.

  const only = (over: Partial<BadgeLayout["fields"]>): BadgeLayout => ({
    ...DEFAULT_BADGE_LAYOUT,
    align: "left",
    fields: { ...DEFAULT_BADGE_LAYOUT.fields, ...over },
  });

  it("defaults print the badge exactly as before", async () => {
    await render();
    expect(rectCalls.length).toBe(1); // the border
    expect(find("Jane Doe")).toBeDefined();
    expect(find("United Arab Emirates")).toBeDefined();
    expect(find("DELEGATE")).toBeDefined();
    expect(find("007")).toBeDefined();
    // Organisation is the one field that defaults OFF: it has never rendered,
    // so switching it on for everyone would change every existing badge.
    expect(find("Meeting Minds Experts")).toBeUndefined();
  });

  it("border off draws no rectangle at all", async () => {
    await render(only({ border: false }));
    expect(rectCalls.length).toBe(0);
  });

  it("renders the overprint set: name, organisation, role, nothing else", async () => {
    await render(
      only({
        border: false,
        organization: true,
        country: false,
        barcode: false,
        registrationNumber: false,
      }),
    );
    expect(rectCalls.length).toBe(0);
    expect(find("Jane Doe")).toBeDefined();
    expect(find("Meeting Minds Experts")).toBeDefined();
    expect(find("DELEGATE")).toBeDefined();
    expect(find("United Arab Emirates")).toBeUndefined();
    expect(find("007")).toBeUndefined();
  });

  it("prints organisation and country on ONE line, joined by a middot", async () => {
    // They used to be mutually exclusive, organisation winning, because both
    // wanted the same band. That left a Country switch that was on and printed
    // nothing (owner spotted it in the preview, Aug 26 2026).
    await render(only({ organization: true }));
    const line = find("Meeting Minds Experts");
    expect(line).toBeDefined();
    expect(line!.str).toBe("Meeting Minds Experts \u00B7 United Arab Emirates");
    // One draw call, not two stacked on the same coordinate.
    expect(textCalls.filter((c) => c.str.includes("United Arab Emirates")).length).toBe(1);
  });

  it("either one alone still prints alone, with no stray separator", async () => {
    await render(only({ organization: true, country: false }));
    expect(find("Meeting Minds Experts")!.str).toBe("Meeting Minds Experts");
    expect(find("\u00B7")).toBeUndefined();

    textCalls = [];
    await render(only({ organization: false, country: true }));
    expect(find("United Arab Emirates")!.str).toBe("United Arab Emirates");
    expect(find("\u00B7")).toBeUndefined();
  });

  it("turning the barcode off skips the RASTERIZATION, not just the draw", async () => {
    // A print run is thousands of CPU-bound bwip-js calls on the box that also
    // serves the live scanner, so the saving that matters is not rendering
    // them at all. Asserting on `doc.image` instead would pass even if every
    // barcode were still rasterized and then thrown away — which is exactly
    // what a mutation run caught this test doing.
    vi.mocked(renderBarcodePng).mockClear();
    await render(only({ barcode: false }));
    expect(renderBarcodePng).not.toHaveBeenCalled();

    vi.mocked(renderBarcodePng).mockClear();
    await render(only({ barcode: true }));
    expect(renderBarcodePng).toHaveBeenCalledTimes(1);
  });

  it("a malformed fields blob falls back per field, never blanking the badge", async () => {
    const { readBadgeLayout } = await import("@/lib/badge-layout");
    const layout = readBadgeLayout({
      settings: { badge: { fields: { border: "no", name: false } } },
    });
    expect(layout.fields.border).toBe(true); // bad value -> default
    expect(layout.fields.name).toBe(false); // good value -> honoured
  });
});

describe("the DTCM compliance code prints as a QR only", () => {
  // Owner, Aug 25 2026. The 36-character UUID used to print in plain text
  // beside the QR so an inspector could read it if a scan failed. It is a
  // compliance CREDENTIAL, and a badge is worn in public and photographed, so
  // a legible copy ended up in every group photo of the event.
  const withDtcm = { ...REG, dtcmBarcode: "11111111-2222-4333-8444-555555555555" };

  it("draws the QR image", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "image");
    await generateBadgePDF([withDtcm], DEFAULT_BADGE_LAYOUT, true);
    // The entry barcode plus the DTCM QR.
    expect(spy.mock.calls.length).toBe(2);
  });

  it("never writes the code, or the DTCM label, as text", async () => {
    await generateBadgePDF([withDtcm], DEFAULT_BADGE_LAYOUT, true);
    const printed = textCalls.map((c) => c.str).join(" | ");
    expect(printed).not.toContain("11111111");
    expect(printed).not.toContain("555555555555");
    expect(printed).not.toContain("DTCM");
  });

  it("still prints the rest of the badge unchanged", async () => {
    // Removing the band's text must not disturb anything above it.
    await generateBadgePDF([withDtcm], DEFAULT_BADGE_LAYOUT, true);
    expect(find("Jane Doe")).toBeDefined();
    expect(find("DELEGATE")).toBeDefined();
  });
});

describe("a long name cannot collide with its neighbours", () => {
  /**
   * THE REGRESSION, from the settings preview on Aug 26 2026. The registration
   * number sat at +58, directly under the name, and the name is allowed to
   * wrap — so this exact sample printed its second line straight through the
   * number.
   *
   * These assert the drawn ORDER rather than the coordinates, so they survive
   * the bands being re-tuned but fail the moment two of them share space.
   */
  const LONG: BadgeRegistration = {
    ...REG,
    attendee: { ...REG.attendee, firstName: "Abdulrahman", lastName: "Al-Muhairi-Sample" },
  };

  it("draws the registration number ABOVE the name", async () => {
    await render(DEFAULT_BADGE_LAYOUT, LONG);
    const serial = find("007")!;
    const name = find("Abdulrahman")!;
    expect(serial).toBeDefined();
    expect(name).toBeDefined();
    expect(serial.y).toBeLessThan(name.y);
    // And with a full line box of clearance, not merely one point.
    expect(name.y - serial.y).toBeGreaterThanOrEqual(12);
  });

  it("keeps the name above the organisation / country line", async () => {
    await render(
      { ...DEFAULT_BADGE_LAYOUT, fields: { ...DEFAULT_BADGE_LAYOUT.fields, organization: true } },
      LONG,
    );
    expect(find("Abdulrahman")!.y).toBeLessThan(find("United Arab Emirates")!.y);
  });

  it("holds at a raised name size, where the name can no longer wrap", async () => {
    // pdfkit ellipsises at the band boundary, so the guarantee is that nothing
    // MOVES: the number and the detail line stay exactly where they were.
    const big: BadgeLayout = {
      ...DEFAULT_BADGE_LAYOUT,
      fontSizes: { ...DEFAULT_BADGE_LAYOUT.fontSizes, name: 30 },
    };
    await render(big, LONG);
    const serial = find("007")!;
    expect(serial.y).toBeCloseTo(BASE_TOP_MARGIN + 14, 10);
    expect(find("United Arab Emirates")!.y).toBeCloseTo(BASE_TOP_MARGIN + 72, 10);
    expect(fontSizes).toContain(30);
  });
});

describe("the organiser controls the type sizes", () => {
  it("uses the saved sizes rather than the historical constants", async () => {
    await render({
      ...DEFAULT_BADGE_LAYOUT,
      fontSizes: { name: 22, detail: 13, badgeType: 16 },
    });
    expect(fontSizes).toContain(22);
    expect(fontSizes).toContain(13);
    expect(fontSizes).toContain(16);
    // The registration number is deliberately not organiser-controlled.
    expect(fontSizes).toContain(10);
  });

  it("scales the chosen sizes with the badge, like the defaults", async () => {
    await render({
      ...DEFAULT_BADGE_LAYOUT,
      widthPt: BASE_BADGE_W / 2,
      heightPt: BASE_BADGE_H / 2,
      fontSizes: { ...DEFAULT_BADGE_LAYOUT.fontSizes, name: 22 },
    });
    expect(fontSizes).toContain(11); // 22 * 0.5
  });
});
