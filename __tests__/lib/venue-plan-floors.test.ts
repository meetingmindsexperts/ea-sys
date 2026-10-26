/**
 * A venue on two floors (owner, Oct 26: Ground and Level 1, joined by stairs and lifts drawn in the same
 * place on both, a short fade between them). Pins the model, the checks, the building the 3D venue walks,
 * the editor's per-floor edits and the AI attendees' words.
 */
import { describe, it, expect } from "vitest";
import { describeVenue } from "@/lib/venue/ai-prompt";
import { checkLayout } from "@/lib/venue/layout-check";
import { floorLinks, floorView, planFloors, planIssues, planSchema, withFloor, type VenuePlan } from "@/lib/venue/plan";
import { addFixture, addWalkway, moveTo, toFloor } from "@/lib/venue/plan-edit";
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { buildVenueLayout, layoutFromPlan } from "@/lib/venue/plan-layout";
import type { VenueRoom } from "@/lib/venue/rooms";

const rooms: VenueRoom[] = [
  { id: "foyer", kind: "foyer", name: "Grand Foyer", capacity: 600 },
  { id: "plenary", kind: "plenary", name: "Plenary Hall", capacity: 500 },
  { id: "hall-1", kind: "hall", name: "Hall 1", capacity: 120 },
  { id: "hall-2", kind: "hall", name: "Hall 2", capacity: 80 },
];

/** BHS2026's saved plan (prod, Oct 26) with Hall 2 upstairs, off an upper corridor, reached by the lift. */
const twoFloors = (): VenuePlan => ({
  v: 1,
  rooms: [
    { id: "foyer", door: { at: 6.5, wall: "n", width: 10.4 }, rect: [-12, 0, 12, 18.5] },
    { id: "hall-1", door: { at: -10.25, wall: "e", width: 2.6 }, rect: [-12, -20.5, 1, 0] },
    { id: "plenary", door: { at: 6.5, wall: "s", width: 6 }, rect: [-12, -48, 12, -20.5] },
    { id: "hall-2", floor: "level-1", door: { at: -10, wall: "e", width: 2.6 }, rect: [-12, -20.5, 1, 0] },
  ],
  corridors: [
    { id: "corridor", name: "Main Corridor", rect: [1, -20.5, 12, 0] },
    { id: "upper", floor: "level-1", name: "Upper Corridor", rect: [1, -20.5, 12, 0] },
  ],
  entrance: { at: 0, wall: "s", width: 18 },
  fixtures: [
    { id: "lift-1", kind: "lift", name: "", dir: "w", rect: [9.4, -13.5, 12, -10.9] },
    { id: "lift-2", kind: "lift", name: "", dir: "w", floor: "level-1", rect: [9.4, -13.5, 12, -10.9] },
  ],
});

describe("the plan model", () => {
  it("reads a plan saved before floors as all on the ground floor", () => {
    const old = { ...twoFloors(), rooms: twoFloors().rooms.slice(0, 3), corridors: twoFloors().corridors.slice(0, 1), fixtures: [] };
    const parsed = planSchema.parse(JSON.parse(JSON.stringify(old)));
    expect(planFloors(parsed)).toEqual(["ground"]);
    expect(planIssues(rooms.slice(0, 3), parsed)).toEqual([]);
  });

  it("allows two floors and no more", () => {
    expect(planSchema.safeParse(twoFloors()).success).toBe(true);
    const third = { ...twoFloors(), corridors: [...twoFloors().corridors, { id: "attic", floor: "level-2", name: "Attic", rect: [0, 0, 5, 5] }] };
    expect(planSchema.safeParse(third).success).toBe(false);
  });

  it("lets areas on different floors stand over each other, but not on the same floor", () => {
    expect(planIssues(rooms, twoFloors())).toEqual([]);
    const clash = twoFloors();
    clash.rooms[3] = { ...clash.rooms[3], floor: undefined };
    expect(planIssues(rooms, clash)).toContain("Hall 1 and Hall 2 overlap");
  });

  it("keeps the foyer on the ground floor", () => {
    const p = twoFloors();
    p.rooms[0] = { ...p.rooms[0], floor: "level-1" };
    expect(planIssues(rooms, p)).toContain("Grand Foyer is the way in, so it stays on the ground floor");
  });

  it("joins a lift to the lift drawn in the same place on the ground floor, and refuses one with nothing under it", () => {
    expect(floorLinks(twoFloors()).map((l) => [l.lower.id, l.upper.id])).toEqual([["lift-1", "lift-2"]]);
    const off = twoFloors();
    off.fixtures[1] = { ...off.fixtures[1], rect: [9.4, -6, 12, -3.4] };
    expect(planIssues(rooms, off)).toContain("Lift on Level 1 has no lift under it on the ground floor. Draw them in the same place on both floors.");
    const none = { ...twoFloors(), fixtures: twoFloors().fixtures.slice(0, 1) };
    expect(planIssues(rooms, none)).toContain("Level 1 needs stairs or a lift, drawn in the same place on both floors");
  });

  it("splits a plan into one floor's view and puts an edited view back, leaving an untouched plan equal", () => {
    const p = twoFloors();
    const up = floorView(p, "level-1");
    expect(up.rooms.map((r) => r.id)).toEqual(["hall-2"]);
    expect(up.otherIds).toContain("lift-1");
    expect(withFloor(p, "level-1", up)).toEqual(p);
    expect(withFloor(p, "ground", floorView(p, "ground"))).toEqual(p);
  });
});

describe("the building", () => {
  it("builds a one-floor plan exactly as before: no floors, no floor hotspots", () => {
    const one = { ...twoFloors(), rooms: twoFloors().rooms.slice(0, 3), corridors: twoFloors().corridors.slice(0, 1), fixtures: [] };
    const built = layoutFromPlan(rooms.slice(0, 3), one, { eventName: "" }).layout;
    expect(built.levels).toBeUndefined();
    expect(built.zones.every((z) => z.level === undefined)).toBe(true);
  });

  it("stands Level 1 beside the ground floor, apart, each zone marked with its floor", () => {
    const { layout, issues } = layoutFromPlan(rooms, twoFloors(), { eventName: "" });
    expect(issues).toEqual([]);
    expect(layout.levels?.map((l) => l.name)).toEqual(["Ground", "Level 1"]);
    const [ground, upper] = layout.levels!;
    expect(upper.bounds[0] - ground.bounds[2]).toBe(30);
    expect(layout.zones.find((z) => z.id === "hall-2")?.level).toBe("level-1");
    expect(layout.zones.find((z) => z.id === "foyer")?.level).toBe("ground");
  });

  it("puts a hotspot at each end of the lift that takes you to the other end, facing out", () => {
    const { layout } = layoutFromPlan(rooms, twoFloors(), { eventName: "" });
    const floors = layout.hotspots.filter((h) => h.kind === "floor");
    expect(floors.map((h) => [h.prompt, h.x, h.z, h.to])).toEqual([
      ["Take the lift up to Level 1", 8, -12.2, [62, -12.2, -1.57]],
      ["Take the lift down to the Ground floor", 62, -12.2, [8, -12.2, -1.57]],
    ]);
  });

  it("is walkable through the lift, and not without it", () => {
    expect(checkLayout(layoutFromPlan(rooms, twoFloors(), { eventName: "" }).layout).issues).toEqual([]);
    const cut = { ...twoFloors(), fixtures: twoFloors().fixtures.slice(0, 1) };
    expect(checkLayout(layoutFromPlan(rooms, cut, { eventName: "" }).layout).issues).toContain("Hall 2 cannot be reached from the entrance");
  });

  it("moves Level 1's door openings with its walls, so a door in a north or south wall upstairs is open", () => {
    const { rooms: r, plan } = PLAN_FIXTURES["drawn-two-floors"];
    const built = buildVenueLayout(r, plan, { eventName: "" });
    expect(built.mode).toBe("drawn");
    const door = built.layout.doors.find((d) => d.between[1] === "workshop")!;
    const wall = built.layout.walls.find((w) => w.axis === "x" && w.k === door.z && w.a0 <= door.x && w.a1 >= door.x)!;
    expect(wall.opens.some((o) => o.a < door.x && o.b > door.x)).toBe(true);
    expect(checkLayout(built.layout).issues).toEqual([]);
  });

  it("numbers stands on through both floors, so no two stands share a number or a sponsor (review MED)", () => {
    const r: VenueRoom[] = [...rooms, { id: "expo-1", kind: "exhibition", name: "Expo Ground", capacity: 120 }, { id: "expo-2", kind: "exhibition", name: "Expo Upstairs", capacity: 120 }];
    const p = twoFloors();
    p.rooms.push({ id: "expo-1", door: { at: -10, wall: "w", width: 2.6 }, rect: [12, -20.5, 36, 0] }, { id: "expo-2", floor: "level-1", door: { at: -10, wall: "w", width: 2.6 }, rect: [12, -20.5, 36, 0] });
    const { layout } = layoutFromPlan(r, p, { eventName: "" });
    const ns = layout.items.flatMap((it) => (it.t === "stand" ? [it.n] : []));
    expect(ns.length).toBeGreaterThan(4);
    expect(ns).toEqual(ns.map((_, i) => i + 1));
    const ids = layout.hotspots.filter((h) => h.kind === "stand").map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ns.map((n) => `stand-${n}`));
  });

  it("refuses stairs whose landing would fall through a wall into the next room (review MED)", () => {
    const { rooms: r, plan } = PLAN_FIXTURES["drawn-two-floors"];
    const flush = { ...plan, fixtures: plan.fixtures.map((f) => (f.kind === "stairs" ? { ...f, rect: [1.5, -3, 4.5, 0] as [number, number, number, number] } : f)) };
    const { issues } = layoutFromPlan(r, flush, { eventName: "" });
    expect(issues).toContain("Stairs on Ground: there is no floor in front of it to step out onto. Turn it, or move it away from the wall.");
    expect(buildVenueLayout(r, flush, { eventName: "" }).mode).toBe("automatic");
  });

  it("draws Level 1's stairs as the stairwell going down", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "st-1", kind: "stairs", name: "", dir: "n", rect: [1.5, -8, 4.5, -2] }, { id: "st-2", kind: "stairs", name: "", dir: "n", floor: "level-1", rect: [1.5, -8, 4.5, -2] });
    const { layout } = buildVenueLayout(rooms, p, { eventName: "" });
    const stairs = layout.items.filter((it) => it.t === "fixture" && it.kind === "stairs");
    expect(stairs.map((it) => it.t === "fixture" && !!it.down)).toEqual([false, true]);
    expect(layout.hotspots.filter((h) => h.kind === "floor").map((h) => h.prompt)).toContain("Take the stairs up to Level 1");
  });

  it("tells AI attendees which rooms are upstairs and how to get there", () => {
    const text = describeVenue(layoutFromPlan(rooms, twoFloors(), { eventName: "" }).layout);
    expect(text).toContain("On Level 1, off the upper corridor: Hall 2");
    expect(text).toContain("A lift leads up to Level 1.");
  });
});

describe("the editor's floors", () => {
  it("moves a room to Level 1 over where it stood, with the fixtures in it", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "pillar-1", kind: "pillar", name: "", dir: "n", rect: [-6, -40, -5, -39] });
    const moved = toFloor(p, { kind: "room", id: "plenary" }, "level-1", "foyer");
    expect(moved.rooms.find((r) => r.id === "plenary")).toMatchObject({ floor: "level-1", rect: [-12, -48, 12, -20.5] });
    expect(moved.fixtures.find((f) => f.id === "pillar-1")?.floor).toBe("level-1");
    expect(toFloor(moved, { kind: "room", id: "plenary" }, "ground", "foyer")).toEqual(p);
  });

  it("puts a room beside Level 1's building when its place there is taken", () => {
    const moved = toFloor(twoFloors(), { kind: "room", id: "hall-1" }, "level-1", "foyer");
    const hall = moved.rooms.find((r) => r.id === "hall-1")!;
    expect(hall.floor).toBe("level-1");
    expect(hall.rect[0]).toBeGreaterThanOrEqual(12);
  });

  it("never moves the foyer off the ground floor", () => {
    const p = twoFloors();
    expect(toFloor(p, { kind: "room", id: "foyer" }, "level-1", "foyer")).toBe(p);
  });

  it("edits on one floor leave the other alone, and new ids never repeat the other floor's", () => {
    const p = twoFloors();
    const up = floorView(p, "level-1");
    const next = withFloor(p, "level-1", moveTo(up, { kind: "room", id: "hall-2" }, -12, -30, "foyer"));
    expect(floorView(next, "ground")).toEqual(floorView(p, "ground"));
    const walk = addWalkway(floorView(p, "level-1"), [20, 0, 26, 20])!;
    const fix = addFixture(floorView(p, "level-1"), "lift", [1, -20.5, 12, 0])!;
    expect(walk.id).not.toBe("corridor");
    expect(fix.id).not.toBe("lift-1");
    expect(withFloor(p, "level-1", walk.plan).corridors.find((c) => c.id === walk.id)?.floor).toBe("level-1");
  });
});
