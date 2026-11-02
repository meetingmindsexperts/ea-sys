/**
 * Stands drafted from the venue's drawing (drawing-labels.ts; section 10, "later, after A to D"): a vector PDF's
 * labels joined from their pieces, each size label given the box drawn around it, and the labels turned into stands
 * for one floor with numbers and sponsors, never overlapping and never outside a room. The Conrad Dubai's own
 * drawing (screenshots/venue-demo) is pinned as read from its PDF.
 */
import { describe, it, expect } from "vitest";
import { draftStands, labelsFromText, matchSponsor, pageBoxes, sponsorKey, withBoxes, type PdfOps, type TextPiece } from "@/lib/venue/drawing-labels";
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { MAX_DRAWING_LABELS, PLAN_MAX_FIXTURES, floorView, planIssues, planSchema, withFloor, type DrawingLabel, type PlanUnderlay, type VenuePlan } from "@/lib/venue/plan";
import { exhibitorPlan } from "@/lib/venue/exhibitor-view";
import conrad from "./venue-conrad-drawing-labels.json";

/** A piece of upright text at (x, y) on its baseline, `h` high, running `w` along. */
const piece = (s: string, x: number, y: number, w: number, h = 10): TextPiece => ({ s, m: [h, 0, 0, -h, x, y], w });
/** The same, reading upwards. */
const upwards = (s: string, x: number, y: number, w: number, h = 10): TextPiece => ({ s, m: [0, -h, -h, 0, x, y], w });

describe("joining the PDF's text pieces into labels", () => {
  it("joins pieces that carry on along a line, with a space only at a word's gap", () => {
    const labels = labelsFromText([piece("6", 100, 50, 6), piece("x3", 106, 50, 12), piece("Program", 300, 50, 40), piece("Wall", 344, 50, 22), piece("Far", 500, 50, 15)]);
    expect(labels.map((l) => l.t)).toEqual(["6x3", "Program Wall", "Far"]);
  });

  it("puts each label's centre in the middle of its letters, and marks text that reads upwards", () => {
    const [flat] = labelsFromText([piece("3x3", 100, 50, 20)]);
    expect(flat).toEqual({ t: "3x3", x: 110, y: 45, h: 10 });
    const [up] = labelsFromText([upwards("4x3", 100, 200, 20)]);
    expect(up.v).toBe(true);
    expect(up.x).toBe(95);
    expect(up.y).toBe(190);
  });

  it("drops empty, punctuation-only and over-long labels, and keeps at most the limit", () => {
    expect(labelsFromText([piece("  ", 0, 0, 5), piece("--", 50, 0, 5), piece("x".repeat(41), 100, 0, 200)])).toEqual([]);
    const many = Array.from({ length: MAX_DRAWING_LABELS + 5 }, (_, i) => piece("3x3", 0, i * 40, 20));
    expect(labelsFromText(many)).toHaveLength(MAX_DRAWING_LABELS);
  });
});

describe("the boxes the drawing draws", () => {
  const OPS: PdfOps = { save: 1, restore: 2, transform: 3, constructPath: 4, rectangle: 19, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6 };
  const rect = (x0: number, y0: number, x1: number, y1: number) => [[19], [x0, y0, x1 - x0, y1 - y0], [x0, y0, x1, y1]];

  it("follows the page's transforms and forms, and leaves out paths that are not one rectangle", () => {
    const fns = [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath, OPS.constructPath];
    const args = [null, [2, 0, 0, 2, 10, 0], rect(0, 0, 5, 5), null, [[1, 0, 0, 1, 100, 100], [0, 0, 1, 1]], rect(0, 0, 10, 20), null, rect(1, 1, 2, 2), [[13, 14], [0, 0, 1, 1], [0, 0, 1, 1]]];
    // The viewport turns the page upside down, as pdfjs's does.
    expect(pageBoxes(fns, args, OPS, [1, 0, 0, -1, 0, 1000])).toEqual([
      [10, 990, 20, 1000],
      [100, 880, 110, 900],
      [1, 998, 2, 999],
    ]);
  });

  it("leaves out a rectangle turned by other than a quarter", () => {
    const c = Math.SQRT1_2;
    expect(pageBoxes([3, 4], [[c, c, -c, c, 0, 0], rect(0, 0, 5, 5)], OPS, [1, 0, 0, 1, 0, 0])).toEqual([]);
  });

  it("gives a size label the smallest box around it with the size's shape", () => {
    const label: DrawingLabel = { t: "6x3", x: 50, y: 20, h: 8 };
    const boxes: [number, number, number, number][] = [
      [0, 0, 1000, 1000], // the room: square, not 2 to 1
      [10, 0, 130, 60], // the stand, 2 to 1
      [0, 0, 300, 150], // a bigger 2 to 1 box
      [40, 10, 60, 30], // around the label, but square
    ];
    expect(withBoxes([label], boxes)[0].b).toEqual([10, 0, 130, 60]);
    expect(withBoxes([{ ...label, t: "Takeda" }], boxes)[0].b).toBeUndefined();
    expect(withBoxes([label], [[0, 0, 30, 30]])[0].b).toBeUndefined();
  });
});

describe("which sponsor a name means", () => {
  const sponsors = ["Takeda Pharmaceuticals", "Novo Nordisk", "J&J", "Abbott Laboratories", "Abbott Diagnostics", "Al Naghi Medical"].map((name, i) => ({ id: `sp${i}`, name }));

  it("matches leaving company words out, then by a name's start, never when two sponsors could be meant", () => {
    expect(sponsorKey("Takeda Pharma FZE")).toBe("takeda");
    expect(matchSponsor("Takeda", sponsors)?.id).toBe("sp0");
    expect(matchSponsor("Novo Nordisk", sponsors)?.id).toBe("sp1");
    expect(matchSponsor("J&J", sponsors)?.id).toBe("sp2");
    expect(matchSponsor("Al Naghi", sponsors)?.id).toBe("sp5");
    expect(matchSponsor("Abbott", sponsors)).toBeNull();
    expect(matchSponsor("Pfizer", sponsors)).toBeNull();
    expect(matchSponsor("AB", sponsors)).toBeNull();
  });
});

describe("drafting a floor's stands", () => {
  // The plenary is [20, 0, 50, 30]; the drawing lies at the origin, 0.1 m to a pixel.
  const view = floorView({ ...PLAN_FIXTURES["drawn-sideways"].plan, standsPlaced: true }, "ground");
  const drawing = (labels: DrawingLabel[]): PlanUnderlay => ({ path: "/uploads/venue-drawings/e/x.jpg", name: "d", px: [1000, 1000], mpp: 0.1, at: [0, 0], opacity: 0.7, labels });
  const sponsors = [{ id: "sp-t", name: "Takeda" }, { id: "sp-l", name: "Lilly" }];
  const at = (x: number, z: number) => ({ x: x * 10, y: z * 10, h: 4 });

  it("puts a boxed stand in the middle of its box, turned the way the box is long, with its number and sponsor", () => {
    const d = draftStands(
      view,
      drawing([
        { t: "6x3", ...at(30, 10), b: [250, 50, 280, 110] }, // a box 3 m wide and 6 m deep: turned
        { t: "07", ...at(27, 9) },
        { t: "Takeda", ...at(26, 7) },
      ]),
      sponsors,
      { maxFixtures: PLAN_MAX_FIXTURES },
    );
    const [stand] = d.plan.fixtures.filter((f) => f.kind === "stand");
    expect(stand.rect).toEqual([25, 5, 28, 11]);
    expect(stand.number).toBe("07");
    expect(stand.sponsorId).toBe("sp-t");
    expect(d).toMatchObject({ stands: 1, tables: 0, withSponsor: 1, unmatched: [], boxScale: null });
    expect(d.added).toEqual([stand.id]);
  });

  it("numbers what the drawing leaves unnumbered row by row, tables as T1 on, and lists names with no sponsor", () => {
    const d = draftStands(view, drawing([{ t: "3x3", ...at(40, 20) }, { t: "3x3", ...at(30, 20) }, { t: "Table", ...at(35, 5) }, { t: "Ferring", ...at(40, 22) }]), sponsors, { maxFixtures: PLAN_MAX_FIXTURES });
    const placed = d.plan.fixtures.filter((f) => f.kind === "stand" || f.kind === "table").map((f) => [f.kind, f.number, f.rect]);
    expect(placed).toEqual([
      ["table", "T1", [34, 4.5, 36, 5.5]],
      ["stand", "1", [28.5, 18.5, 31.5, 21.5]],
      ["stand", "2", [38.5, 18.5, 41.5, 21.5]],
    ]);
    expect(d.unmatched).toEqual(["Ferring"]);
  });

  it("takes a free number from the other floor's into account, and a taken one is replaced", () => {
    const upstairs = { ...view, otherNumbers: ["07", "08"] };
    const d = draftStands(upstairs, drawing([{ t: "3x3", ...at(30, 20) }, { t: "07", ...at(30, 19) }]), [], { maxFixtures: PLAN_MAX_FIXTURES });
    expect(d.plan.fixtures.find((f) => f.kind === "stand")?.number).toBe("09");
  });

  it("moves a stand into its room, opens it away from the wall behind it, and leaves out one in no room", () => {
    const d = draftStands(view, drawing([{ t: "3x3", ...at(49.5, 22) }, { t: "3x3", ...at(70, 70) }]), [], { maxFixtures: PLAN_MAX_FIXTURES });
    const [stand] = d.plan.fixtures.filter((f) => f.kind === "stand");
    expect(stand.rect).toEqual([47, 20.5, 50, 23.5]);
    expect(stand.dir).toBe("w");
    expect(d.outside).toBe(1);
  });

  it("pushes a stand off a neighbour it only just overlaps, and leaves out one on top of another", () => {
    const d = draftStands(view, drawing([{ t: "3x3", ...at(30, 20) }, { t: "3x3", ...at(32.8, 20) }, { t: "3x3", ...at(30.2, 20.1) }]), [], { maxFixtures: PLAN_MAX_FIXTURES });
    const rects = d.plan.fixtures.filter((f) => f.kind === "stand").map((f) => f.rect);
    expect(rects).toEqual([
      [28.5, 18.5, 31.5, 21.5],
      [31.5, 18.5, 34.5, 21.5],
    ]);
    expect(d.overlapping).toBe(1);
  });

  it("can remove the floor's own stands first, and stops at the plan's limit counting the other floor", () => {
    const first = draftStands(view, drawing([{ t: "3x3", ...at(30, 20) }]), [], { maxFixtures: PLAN_MAX_FIXTURES }).plan;
    const again = draftStands(first, drawing([{ t: "3x3", ...at(30, 20) }]), [], { replace: true, maxFixtures: PLAN_MAX_FIXTURES });
    expect(again.removed).toBe(1);
    expect(again.plan.fixtures.filter((f) => f.kind === "stand")).toHaveLength(1);
    const full = draftStands(view, drawing([{ t: "3x3", ...at(30, 20) }, { t: "3x3", ...at(40, 20) }]), [], { otherFixtures: PLAN_MAX_FIXTURES - view.fixtures.length - 1, maxFixtures: PLAN_MAX_FIXTURES });
    expect([full.stands, full.overLimit]).toEqual([1, 1]);
  });

  it("says when the drawing's stand boxes are not their labelled size at its scale", () => {
    const d = draftStands(view, drawing([{ t: "3x3", ...at(30, 20), b: [280, 180, 320, 220] }]), [], { maxFixtures: PLAN_MAX_FIXTURES });
    expect(d.boxScale).toBe(1.33);
  });

  it("gives a plan the save accepts, with the floor's other fixtures kept", () => {
    const d = draftStands(view, drawing([{ t: "3x3", ...at(30, 20) }, { t: "6x3", ...at(40, 10) }, { t: "Lilly", ...at(40, 11) }]), sponsors, { maxFixtures: PLAN_MAX_FIXTURES });
    const whole = withFloor(PLAN_FIXTURES["drawn-sideways"].plan, "ground", d.plan);
    expect(planIssues(PLAN_FIXTURES["drawn-sideways"].rooms, whole)).toEqual([]);
    expect(planSchema.safeParse(whole).success).toBe(true);
    expect(whole.fixtures.filter((f) => f.kind === "lift")).toHaveLength(1);
    expect(whole.standsPlaced).toBe(true);
  });
});

describe("the Conrad Dubai's drawing, as read from its PDF", () => {
  const labels = conrad as DrawingLabel[];
  // Where the demo seed puts it: 1300 px read at 0.1 m, the origin moved.
  const u: PlanUnderlay = { path: "/uploads/venue-drawings/e/x.jpg", name: "Conrad", px: [4000, 2827], mpp: (0.1 * 1300) / 4000, at: [-30, -14], opacity: 0.7, labels };
  const hall: VenuePlan = { v: 1, rooms: [{ id: "hall", rect: [-30, -14, 100, 80], door: { wall: "s", at: 0, width: 4 } }], corridors: [], entrance: { wall: "s", at: 0, width: 4 }, fixtures: [], standsPlaced: true };
  const names = ["Hikma", "Endosoft", "Al Naghi", "Novo Nordisk", "Endohub", "Abbott", "Xeedia", "NewBridge", "Al Shirawi", "Premium MS", "Olympus", "Spectre", "Sanofi", "Takeda", "AbbVie", "Ferring", "Ipsen", "Lilly", "Amgen", "J&J", "Gilead"];
  const d = draftStands(hall, u, names.map((name, i) => ({ id: `sp${i}`, name })), { maxFixtures: PLAN_MAX_FIXTURES });

  it("finds every stand and table, each in its drawn box, and every sponsor named on it", () => {
    expect(labels.filter((l) => l.b)).toHaveLength(35);
    expect(d).toMatchObject({ stands: 30, tables: 5, withSponsor: 21, unmatched: [], outside: 0, overlapping: 0, boxScale: 1.33 });
    const takeda = d.plan.fixtures.find((f) => f.sponsorId === `sp${names.indexOf("Takeda")}`)!;
    expect(takeda.rect[2] - takeda.rect[0]).toBe(6);
    const olympus = d.plan.fixtures.find((f) => f.sponsorId === `sp${names.indexOf("Olympus")}`)!;
    expect(olympus.rect[3] - olympus.rect[1]).toBe(4);
  });

  it("keeps the labels with the team: the exhibitors' plan never carries them", () => {
    const plan: VenuePlan = { ...hall, underlays: [{ ...u, path: "/uploads/venue-drawings/e/0f0e0d0c-0b0a-4908-8706-050403020100.jpg", exhibitors: true }] };
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(exhibitorPlan(plan).underlays?.[0].labels).toBeUndefined();
    expect(exhibitorPlan(plan).underlays?.[0].path).toBe(plan.underlays![0].path);
  });
});
