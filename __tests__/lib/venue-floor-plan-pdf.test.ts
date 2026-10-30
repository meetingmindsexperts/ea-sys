/**
 * The venue floor plan PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, 3.7): the
 * printed scale is a round ratio that fits, labels never hide stands when a
 * clear spot exists, dates read in the event's time zone, and every template
 * renders, including sponsor names pdfkit's Helvetica cannot encode.
 */
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import { describe, it, expect } from "vitest";
import { generateLayout } from "@/lib/venue/layout";
import { TEMPLATES, TEMPLATE_KEYS } from "@/lib/venue/rooms";
import {
  PLAN_SCALES,
  chooseOrientation,
  chooseScale,
  fitLabel,
  placeLabel,
  planDateLine,
  renderFloorPlanPdf,
  scaleBarMetres,
} from "@/lib/venue/floor-plan-pdf";

describe("chooseScale", () => {
  it("picks the smallest round ratio at which the plan fits", () => {
    const { ratio, ptPerM } = chooseScale(45, 95, 760, 1000);
    expect(PLAN_SCALES).toContain(ratio);
    expect(45 * ptPerM).toBeLessThanOrEqual(760);
    expect(95 * ptPerM).toBeLessThanOrEqual(1000);
    // The next rounder, larger drawing would not fit.
    const bigger = PLAN_SCALES[PLAN_SCALES.indexOf(ratio as (typeof PLAN_SCALES)[number]) - 1];
    if (bigger) {
      const ptBigger = (1000 * 72) / 25.4 / bigger;
      expect(45 * ptBigger > 760 || 95 * ptBigger > 1000).toBe(true);
    }
  });

  it("goes past the list for a huge building rather than overflowing", () => {
    const { ratio, ptPerM } = chooseScale(2000, 2000, 500, 500);
    expect(ratio).toBeGreaterThan(5000);
    expect(2000 * ptPerM).toBeLessThanOrEqual(500);
  });
});

describe("page helpers", () => {
  it("orients the page to the plan", () => {
    expect(chooseOrientation([0, 0, 45, 95])).toBe("portrait");
    expect(chooseOrientation([0, 0, 95, 45])).toBe("landscape");
  });

  it("scale bars are round lengths", () => {
    expect(scaleBarMetres(24)).toBe(5);
    expect(scaleBarMetres(45)).toBe(10);
    expect(scaleBarMetres(84)).toBe(20);
  });

  it("fitLabel shrinks, then cuts with an ellipsis", () => {
    const widthOf = (t: string, size: number) => t.length * size * 0.5;
    expect(fitLabel(widthOf, "Hall A", 100, 10, 5)).toEqual({ text: "Hall A", size: 10 });
    expect(fitLabel(widthOf, "Hall A", 20, 10, 5).size).toBeLessThan(10);
    const cut = fitLabel(widthOf, "A very long room name indeed", 30, 10, 5);
    expect(cut.size).toBe(5);
    expect(cut.text.endsWith("…")).toBe(true);
  });

  it("placeLabel keeps the centre when it is clear, and moves off stands when it is not", () => {
    const room: [number, number, number, number] = [0, 0, 200, 200];
    const label = { w: 60, h: 20 };
    expect(placeLabel(room, label, [])).toEqual({ x: 70, y: 90 });
    const standInMiddle = { box: [60, 80, 140, 120] as [number, number, number, number], weight: 4 };
    const moved = placeLabel(room, label, [standInMiddle]);
    expect(moved).not.toEqual({ x: 70, y: 90 });
  });

  it("dates read in the event's time zone", () => {
    const tz = "Asia/Dubai";
    expect(planDateLine(new Date("2027-03-12T05:00:00Z"), new Date("2027-03-14T15:00:00Z"), tz)).toBe("12 to 14 March 2027");
    expect(planDateLine(new Date("2027-03-30T05:00:00Z"), new Date("2027-04-02T05:00:00Z"), tz)).toBe("30 March to 2 April 2027");
    expect(planDateLine(new Date("2026-12-30T05:00:00Z"), new Date("2027-01-02T05:00:00Z"), tz)).toBe("30 December 2026 to 2 January 2027");
    expect(planDateLine(new Date("2027-03-12T05:00:00Z"), new Date("2027-03-12T15:00:00Z"), tz)).toBe("12 March 2027");
    // 22:00 UTC on the 11th is already the 12th in Dubai.
    expect(planDateLine(new Date("2027-03-11T22:00:00Z"), new Date("2027-03-11T23:00:00Z"), tz)).toBe("12 March 2027");
  });
});

describe("renderFloorPlanPdf", () => {
  it.each(TEMPLATE_KEYS)("renders the %s template on A3 and A4", async (key) => {
    const layout = generateLayout(TEMPLATES[key].rooms, { eventName: "Test" });
    for (const paper of ["A3", "A4"] as const) {
      const pdf = await renderFloorPlanPdf({
        layout,
        eventName: "Annual Summit",
        dateLine: "12 to 14 March 2027",
        place: "Dubai",
        sponsors: [{ id: "s1", name: "Pfizer" }, { id: "s2", name: "Novartis" }],
        paper,
        generatedAt: new Date("2026-10-23T10:00:00Z"),
      });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.subarray(-6).toString()).toContain("%%EOF");
    }
  });

  it("renders placed stands, a sponsor table, an Available stand, a stage and an AV console", async () => {
    const { rooms, plan } = PLAN_FIXTURES["drawn-placed-stands"];
    const pdf = await renderFloorPlanPdf({
      layout: layoutFromPlan(rooms, plan, { eventName: "x" }).layout,
      eventName: "Exhibitor plan",
      dateLine: null,
      place: null,
      sponsors: [{ id: "sp-a", name: "Takeda" }, { id: "sp-b", name: "AbbVie" }],
      paper: "A3",
      generatedAt: new Date(),
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("does not fail on names Helvetica cannot encode", async () => {
    const layout = generateLayout(TEMPLATES.expo.rooms, { eventName: "x" });
    const pdf = await renderFloorPlanPdf({
      layout,
      eventName: "مؤتمر الشرق الأوسط 🎉",
      dateLine: null,
      place: null,
      sponsors: [{ id: "s1", name: "شركة الأدوية" }, { id: "s2", name: "株式会社" }],
      paper: "A3",
      generatedAt: new Date(),
    });
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
