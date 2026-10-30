/**
 * The venue's own drawing under the plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 10, phase B): one per floor, placed over the building, scaled by a
 * line of known length with its starting end held still, saved through the
 * plan's schema only when it is this kind of upload, and never lost by an edit
 * made on one floor's view.
 */
import { describe, it, expect } from "vitest";
import { generateLayout } from "@/lib/venue/layout";
import { LAYOUT_FIXTURES } from "@/lib/venue/layout-fixtures";
import { floorView, planFromLayout, planSchema, withFloor, type PlanUnderlay } from "@/lib/venue/plan";
import { DRAWING_OPACITY, drawingFolder, moveUnderlay, placeUnderlay, scaleUnderlay, sniffDrawing, underlayOf, underlayRect, withUnderlay } from "@/lib/venue/underlay";

const rooms = LAYOUT_FIXTURES.congress;
const plan = planFromLayout(generateLayout(rooms, { eventName: "" }));
const PATH = `${drawingFolder("evt-1")}3f2b1c4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg`;
const file = { path: PATH, name: "Conrad 2F.jpg", px: [4000, 2800] as [number, number] };

describe("placing a drawing", () => {
  it("starts over the floor's building, as wide as it, at the usual see-through", () => {
    const u = placeUnderlay(plan, "ground", file);
    const xs = [...plan.rooms, ...plan.corridors].map((a) => a.rect);
    const x0 = Math.min(...xs.map((r) => r[0]));
    const x1 = Math.max(...xs.map((r) => r[2]));
    const r = underlayRect(u);
    expect(r[0]).toBeCloseTo(x0, 1);
    expect(r[2]).toBeCloseTo(x1, 1);
    expect(u.opacity).toBe(DRAWING_OPACITY);
  });

  it("with nothing drawn on the floor yet, 100 m wide at the origin", () => {
    const u = placeUnderlay(plan, "level-1", file);
    expect(u.at).toEqual([0, 0]);
    expect(u.px[0] * u.mpp).toBeCloseTo(100, 6);
  });

  it("keeps one drawing per floor, the ground floor written as no floor", () => {
    const g = placeUnderlay(plan, "ground", file);
    const both = withUnderlay(withUnderlay(plan, "ground", g), "level-1", { ...g, name: "Upstairs.jpg" });
    expect(underlayOf(both, "ground")?.name).toBe("Conrad 2F.jpg");
    expect(underlayOf(both, "level-1")?.name).toBe("Upstairs.jpg");
    expect(both.underlays!.find((u) => u.name === "Conrad 2F.jpg")!.floor).toBeUndefined();
    const replaced = withUnderlay(both, "ground", { ...g, name: "Conrad v3.jpg" });
    expect(replaced.underlays).toHaveLength(2);
    const removed = withUnderlay(withUnderlay(replaced, "ground", null), "level-1", null);
    expect(removed.underlays).toBeUndefined();
  });
});

describe("setting the scale", () => {
  const u: PlanUnderlay = { path: PATH, name: "x.jpg", px: [1000, 500], mpp: 0.1, at: [10, 20], opacity: 0.7 };

  it("makes the drawn line the length typed, with its first end held still", () => {
    // A line over what the drawing shows 30 m along, said to be 60 m: the drawing doubles about (40, 30).
    const a: [number, number] = [40, 30];
    const b: [number, number] = [70, 30];
    const s = scaleUnderlay(u, a, b, 60)!;
    expect(s.mpp).toBeCloseTo(0.2, 9);
    // Where a fell on the drawing, as a pixel, is still at a.
    const pxA = [(a[0] - u.at[0]) / u.mpp, (a[1] - u.at[1]) / u.mpp];
    expect(s.at[0] + pxA[0] * s.mpp).toBeCloseTo(a[0], 1);
    expect(s.at[1] + pxA[1] * s.mpp).toBeCloseTo(a[1], 1);
  });

  it("refuses a line too short to measure by, or a length that is not a positive number", () => {
    expect(scaleUnderlay(u, [0, 0], [0.01, 0], 5)).toBeNull();
    expect(scaleUnderlay(u, [0, 0], [10, 0], 0)).toBeNull();
    expect(scaleUnderlay(u, [0, 0], [10, 0], Number.NaN)).toBeNull();
  });

  it("moves by the drag, kept inside the plan's limit", () => {
    expect(moveUnderlay(u, 2.5, -1).at).toEqual([12.5, 19]);
    expect(moveUnderlay(u, 10_000, 0).at[0]).toBe(600);
  });
});

describe("what is saved", () => {
  const withDrawing = withUnderlay(plan, "ground", placeUnderlay(plan, "ground", file));

  it("the schema keeps this event's upload", () => {
    expect(planSchema.parse(withDrawing).underlays![0].path).toBe(PATH);
  });

  it("the schema refuses a path that is not a drawing upload, or two drawings on one floor", () => {
    for (const path of ["/uploads/media/2026/10/x.jpg", "/uploads/venue-drawings/evt-1/../../photos/a.jpg", `${PATH}.svg`, "https://example.com/a.jpg"]) {
      expect(planSchema.safeParse({ ...withDrawing, underlays: [{ ...withDrawing.underlays![0], path }] }).success).toBe(false);
    }
    const twice = { ...withDrawing, underlays: [withDrawing.underlays![0], { ...withDrawing.underlays![0], name: "again.jpg" }] };
    expect(planSchema.safeParse(twice).success).toBe(false);
  });

  it("an edit made on one floor's view never drops the drawings", () => {
    const view = floorView(withDrawing, "ground");
    expect(withFloor(withDrawing, "ground", view).underlays).toEqual(withDrawing.underlays);
  });
});

describe("what the upload accepts", () => {
  it("knows a PNG, JPEG and WebP by their first bytes, and nothing else", () => {
    expect(sniffDrawing(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext).toBe("png");
    expect(sniffDrawing(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffDrawing(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.ext).toBe("webp");
    expect(sniffDrawing(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffDrawing(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("review fixes, Oct 30", () => {
  it("clips a long file name to what the plan saves, keeping its extension", async () => {
    const { drawingName } = await import("@/lib/venue/drawing-image");
    const long = `${"Conrad Dubai second floor exhibition layout ".repeat(4)}final v2.png`;
    const name = drawingName(long);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".png")).toBe(true);
    expect(drawingName("Conrad 2F.png")).toBe("Conrad 2F.png");
    const u = { ...placeUnderlay(plan, "ground", file), name };
    expect(planSchema.safeParse(withUnderlay(plan, "ground", u)).success).toBe(true);
  });

  it("keeps a replacement's scale inside what the plan saves, however different its size", async () => {
    const { clampMpp } = await import("@/lib/venue/underlay");
    expect(clampMpp(50)).toBe(10);
    expect(clampMpp(0)).toBe(0.0005);
    expect(clampMpp(0.02)).toBe(0.02);
  });
});
