/**
 * Movable walls (plan.ts `movableWalls`; section 11, step 4): one hotel ballroom divided into sections, each its
 * own room with its own setup. Only the stretch the two rooms share becomes a partition; the pair survives a
 * floor's view, can be cleared, follows the rooms, and is warned about when they move apart.
 */
import { describe, it, expect } from "vitest";
import { checkLayout } from "@/lib/venue/layout-check";
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { buildVenueLayout } from "@/lib/venue/plan-layout";
import { floorView, planSchema, withFloor, type VenuePlan } from "@/lib/venue/plan";
import { adjacentRooms, isMovable, keepListedRooms, movableWallIssues, setMovableWall, sharedEdge } from "@/lib/venue/plan-edit";
import { renderFloorPlanPdf } from "@/lib/venue/floor-plan-pdf";
import { renderRoomSheetPdf } from "@/lib/venue/room-sheet-pdf";
import { floorLayout } from "@/lib/venue/plan-layout";
import { planIssues } from "@/lib/venue/plan";
import { prunedPlan } from "@/services/venue-rooms-service";
import type { VenueRoom } from "@/lib/venue/rooms";

const { rooms, plan } = PLAN_FIXTURES["drawn-ballroom-sections"];
const built = buildVenueLayout(rooms, plan, { eventName: "x" });

describe("the wall between two sections", () => {
  it("only the shared stretch is movable; every other wall stays solid", () => {
    const movable = built.layout.walls.filter((w) => w.movable);
    expect(movable).toEqual([{ axis: "z", k: 36, a0: -26, a1: -6, h: 6, opens: [], movable: true }]);
    const plain = buildVenueLayout(rooms, { ...plan, movableWalls: undefined }, { eventName: "x" });
    expect(plain.layout.walls.some((w) => w.movable)).toBe(false);
  });

  it("each section keeps its own setup, and the venue is walkable", () => {
    expect(built.layout.zones.find((z) => z.id === "breakout-1")?.setup).toBe("classroom");
    expect(built.layout.zones.find((z) => z.id === "breakout-2")?.setup).toBeUndefined();
    expect(checkLayout(built.layout).ok).toBe(true);
  });

  it("draws in the floor plan PDF and on both sections' setup sheets", async () => {
    const at = { eventName: "x", dateLine: null, place: null, generatedAt: new Date(0) };
    expect((await renderFloorPlanPdf({ ...at, layout: built.layout, sponsors: [], paper: "A4" })).subarray(0, 5).toString()).toBe("%PDF-");
    for (const zoneId of ["breakout-1", "breakout-2"]) expect((await renderRoomSheetPdf({ ...at, layout: built.layout, zoneId })).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("editing them", () => {
  const base: VenuePlan = { ...plan, movableWalls: undefined };

  it("offers only the rooms that share at least 2 m of wall, on the same floor", () => {
    expect(adjacentRooms(base, "breakout-1")).toEqual(["breakout-2"]);
    expect(adjacentRooms(base, "foyer")).toEqual([]);
    expect(sharedEdge([0, 0, 10, 10], [10, 4, 20, 8])).toBe(4);
    expect(sharedEdge([0, 0, 10, 10], [11, 0, 20, 10])).toBe(0);
  });

  it("ticks and unticks a wall, in either order of the two rooms", () => {
    const on = setMovableWall(base, "breakout-2", "breakout-1", true);
    expect(isMovable(on, "breakout-1", "breakout-2")).toBe(true);
    const off = setMovableWall(on, "breakout-1", "breakout-2", false);
    expect(isMovable(off, "breakout-1", "breakout-2")).toBe(false);
    expect(off.movableWalls).toEqual([]);
  });

  it("a floor's view keeps them, and clearing the last one in the view clears it from the plan", () => {
    const view = floorView(plan, "ground");
    expect(withFloor(plan, "ground", view).movableWalls).toEqual(plan.movableWalls);
    const cleared = withFloor(plan, "ground", setMovableWall(view, "breakout-1", "breakout-2", false));
    expect(cleared.movableWalls).toBeUndefined();
  });

  it("go with a room taken off the list, and are warned about when the rooms move apart", () => {
    const fewer = keepListedRooms(plan, rooms.filter((r) => r.id !== "breakout-2"));
    expect(fewer.movableWalls).toBeUndefined();
    const apart: VenuePlan = { ...plan, rooms: plan.rooms.map((p) => (p.id === "breakout-2" ? { ...p, rect: [40, -26, 56, -6] as [number, number, number, number] } : p)) };
    expect(movableWallIssues(apart, rooms)).toEqual(["Ballroom R1 and Ballroom R2 no longer share a wall, so the movable wall between them is not drawn"]);
    expect(movableWallIssues(plan, rooms)).toEqual([]);
  });
});

describe("what the plan accepts", () => {
  it("refuses a wall between a room and itself, or the same wall twice", () => {
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, movableWalls: [["breakout-1", "breakout-1"]] }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, movableWalls: [["breakout-1", "breakout-2"], ["breakout-2", "breakout-1"]] }).success).toBe(false);
  });
});

describe("review of dd903533", () => {
  // A foyer above two rooms side by side; its door straddles the join between them, the foyer|R1 wall movable.
  const three: VenueRoom[] = [
    { id: "foyer", name: "Foyer", kind: "foyer", capacity: 100 },
    { id: "r1", name: "R1", kind: "hall", capacity: 30 },
    { id: "r2", name: "R2", kind: "hall", capacity: 30 },
  ];
  const straddle: VenuePlan = {
    v: 1,
    rooms: [
      { id: "foyer", rect: [0, 0, 20, 10], door: { wall: "s", at: 9.5, width: 3 } },
      { id: "r1", rect: [0, 10, 10, 22], door: { wall: "n", at: 5, width: 2.6 } },
      { id: "r2", rect: [10, 10, 20, 22], door: { wall: "n", at: 15, width: 2.6 } },
    ],
    corridors: [],
    entrance: { wall: "n", at: 10, width: 6 },
    fixtures: [],
    movableWalls: [["foyer", "r1"]],
  };

  it("a door across the join of a movable and a solid wall opens both", () => {
    const { layout } = floorLayout(three, straddle, { eventName: "x" });
    const line = layout.walls.filter((w) => w.axis === "x" && w.k === 10);
    const movable = line.find((w) => w.movable)!;
    const solid = line.find((w) => !w.movable && w.a0 <= 10.5 && w.a1 >= 10.5)!;
    expect(movable.opens.some((o) => o.a <= 8.01 && o.b >= 9.99)).toBe(true);
    expect(solid.opens.some((o) => o.a <= 10.01 && o.b >= 10.99)).toBe(true);
  });

  it("a movable wall naming a room not on the plan is an issue; one on another floor's view is not", () => {
    expect(planIssues(three, { ...straddle, movableWalls: [["foyer", "ghost"]] })).toContain("A movable wall names a room that is not on the plan (ghost)");
    expect(planIssues(three, { ...straddle, otherIds: ["ghost"], movableWalls: [["foyer", "ghost"]] }).some((i) => i.includes("movable"))).toBe(false);
  });

  it("saving a room list without a room drops the movable walls beside it, server side", () => {
    const cur = { venue: { plan: { plan, updatedAt: 1, updatedBy: "u" } } };
    const out = prunedPlan(cur, rooms.filter((r) => r.id !== "breakout-2")) as { plan?: { plan: VenuePlan } };
    expect(out.plan?.plan.movableWalls).toBeUndefined();
    expect(out.plan?.plan.rooms.some((p) => p.id === "breakout-2")).toBe(false);
  });
});
