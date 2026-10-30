/**
 * A venue on two floors (owner, Oct 26: Ground and Level 1, joined by stairs and lifts drawn in the same
 * place on both, a short fade between them). Pins the model, the checks, the building the 3D venue walks,
 * the editor's per-floor edits and the AI attendees' words.
 */
import { describe, it, expect } from "vitest";
import { describeVenue } from "@/lib/venue/ai-prompt";
import { checkLayout } from "@/lib/venue/layout-check";
import { floorLinks, floorView, planFloors, planIssues, planSchema, withFloor, type VenuePlan, PLAN_MAX_FIXTURES } from "@/lib/venue/plan";
import { addFixture, addPartner, addWalkway, keepPairs, missingPartner, moveTo, nudge, removeJoined, setSize, turn, toFloor } from "@/lib/venue/plan-edit";
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { buildVenueLayout, doorsLeftShut, floorLayout, layoutFromPlan } from "@/lib/venue/plan-layout";
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
    expect(planIssues(rooms, off)).toContain('Lift on Level 1 has no lift under it on the ground floor. Select it and click "Put the matching lift on Ground".');
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

describe("matching stairs and lifts (owner, Oct 26: lining them up by hand was the hard part)", () => {
  it("knows which stair or lift has nothing in the same place on the other floor, and puts the match there", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "stairs-1", kind: "stairs", name: "Main stairs", dir: "n", floor: "level-1", rect: [1.5, -9, 4.5, -3] });
    expect(missingPartner(p, "stairs-1")).toBe("ground");
    expect(missingPartner(p, "lift-1")).toBeNull();
    const added = addPartner(p, "stairs-1")!;
    const match = added.plan.fixtures.find((f) => f.id === added.id)!;
    expect(match).toMatchObject({ kind: "stairs", name: "Main stairs", dir: "n", rect: [1.5, -9, 4.5, -3] });
    expect(match.floor).toBeUndefined();
    expect(missingPartner(added.plan, "stairs-1")).toBeNull();
    expect(planIssues(rooms, added.plan)).toEqual([]);
  });

  it("does not add a match where no room or walkway on that floor holds the spot", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "stairs-g", kind: "stairs", name: "", dir: "n", rect: [-10, -40, -7, -34] });
    expect(missingPartner(p, "stairs-g")).toBe("level-1");
    expect(addPartner(p, "stairs-g")).toBeNull();
  });

  it("says how to fix a stair or lift with nothing under it", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "stairs-1", kind: "stairs", name: "", dir: "n", floor: "level-1", rect: [1.5, -9, 4.5, -3] });
    expect(planIssues(rooms, p)).toContain('Stairs on Level 1 has no stairs under it on the ground floor. Select it and click "Put the matching stairs on Ground".');
  });
});

describe("registration counter, photo wall and standing banner (owner, Oct 26)", () => {
  const { rooms: r, plan } = PLAN_FIXTURES["drawn-two-floors"];
  const { layout } = layoutFromPlan(r, plan, { eventName: "" });

  it("staffs a registration counter from behind and hands out badges in front", () => {
    const desk = layout.hotspots.find((h) => h.id === "desk-registration-1")!;
    expect(desk).toMatchObject({ prompt: "Collect your badge", title: "Faculty registration", x: -3, z: 10.7 });
    const staff = layout.people.filter((p) => p.role === "staff" && p.z === 7.3);
    expect(staff.map((p) => p.x)).toEqual([-4.5, -1.5]);
  });

  it("takes the foyer's own desk away with its staff and its prompt when a counter stands on it", () => {
    expect(layout.items.some((it) => it.t === "desk" && it.title === "Registration")).toBe(false);
    expect(layout.hotspots.some((h) => h.id === "Registration")).toBe(false);
    expect(layout.people.filter((p) => p.role === "staff" && p.x < -6 && p.z > 7 && p.z < 10)).toEqual([]);
    expect(layout.hotspots.some((h) => h.id === "Information")).toBe(true);
  });

  it("lets a photo wall take a photo, and a banner carry its name", () => {
    expect(layout.hotspots.find((h) => h.id === "photo-photo-wall-1")).toMatchObject({ prompt: "Take a photo here", action: "photo" });
    const banner = layout.items.find((it) => it.t === "fixture" && it.kind === "banner");
    expect(banner).toMatchObject({ name: "Welcome", solid: true });
  });

  it("keeps the venue walkable with them in it", () => {
    expect(checkLayout(layout).issues).toEqual([]);
  });
});

describe("review fixes, Oct 26", () => {
  const { rooms: r, plan } = PLAN_FIXTURES["drawn-two-floors"];
  const without = (ids: string[]) => ({ ...plan, fixtures: plan.fixtures.filter((f) => !ids.includes(f.id)) });
  const deskOf = (title: string) => {
    const d = layoutFromPlan(r, without(["registration-1"]), { eventName: "" }).layout.items.find((it) => it.t === "desk" && it.title === title)!;
    return "r" in d.foot ? null : d.foot;
  };

  it("faces the photo away from the wall, whichever way the visitor walked up", () => {
    const h = layoutFromPlan(r, plan, { eventName: "" }).layout.hotspots.find((x) => x.action === "photo")!;
    expect(h.face).toBe(1.57);
  });

  it("keeps the foyer desk's staff and prompt when a pillar only stands beside it", () => {
    const d = deskOf("Registration")!;
    const pillar = { id: "pillar-9", kind: "pillar" as const, name: "", dir: "n" as const, rect: [d.x1 + 0.1, d.z0, d.x1 + 0.9, d.z0 + 0.8] as [number, number, number, number] };
    const l = layoutFromPlan(r, { ...without(["registration-1"]), fixtures: [...without(["registration-1"]).fixtures, pillar] }, { eventName: "" }).layout;
    expect(l.hotspots.some((h) => h.id === "Registration")).toBe(true);
  });

  it("never stands counter staff inside a fixture listed before the counter", () => {
    const pillar = { id: "pillar-9", kind: "pillar" as const, name: "", dir: "n" as const, rect: [-4.9, 6.9, -4.1, 7.7] as [number, number, number, number] };
    const l = layoutFromPlan(r, { ...plan, fixtures: [pillar, ...plan.fixtures] }, { eventName: "" }).layout;
    expect(l.people.some((p) => p.x > -5.2 && p.x < -3.8 && p.z > 6.6 && p.z < 8)).toBe(false);
  });

  it("says when a counter or photo wall faces a wall", () => {
    const turned = { ...plan, fixtures: plan.fixtures.map((f) => (f.id === "photo-wall-1" ? { ...f, dir: "w" as const } : f)) };
    expect(planIssues(r, turned)).toContain("Photo wall faces a wall. Turn it so its arrow points into the room.");
    expect(planIssues(r, plan)).toEqual([]);
  });

  it("does not match stairs past the fixture limit, counted over both floors", () => {
    const p = twoFloors();
    p.fixtures.push({ id: "stairs-1", kind: "stairs", name: "", dir: "n", floor: "level-1", rect: [1.5, -9, 4.5, -3] });
    for (let i = 0; p.fixtures.length < PLAN_MAX_FIXTURES; i++) p.fixtures.push({ id: `pillar-${i}`, kind: "pillar", name: "", dir: "n", rect: [-11.5 + (i % 10), -47.5 + Math.floor(i / 10), -11.2 + (i % 10), -47.2 + Math.floor(i / 10)] });
    expect(addPartner(p, "stairs-1")).toBeNull();
  });

  it("tells the organiser to move the stairs over the ground floor when nothing on Ground holds the spot", () => {
    const p = twoFloors();
    p.corridors[1] = { ...p.corridors[1], rect: [1, -20.5, 30, 0] };
    p.fixtures.push({ id: "stairs-1", kind: "stairs", name: "", dir: "n", floor: "level-1", rect: [20, -9, 23, -3] });
    expect(planIssues(rooms, p)).toContain('Stairs on Level 1 has no stairs under it on the ground floor. Nothing on the ground floor stands under that spot, so move it over a ground floor room or walkway, then select it and click "Put the matching stairs on Ground".');
  });
});


describe("stairs on two floors, local test fixes (owner, Oct 27)", () => {
  /** Hall 2 alone on Level 1 over Hall 1, no upper walkway, reached by stairs from Hall 1. */
  const lone = (): VenuePlan => {
    const p = twoFloors();
    return {
      ...p,
      corridors: p.corridors.slice(0, 1),
      fixtures: [
        { id: "stairs-1", kind: "stairs", name: "", dir: "s", rect: [-8, -15, -5, -9] },
        { id: "stairs-2", kind: "stairs", name: "", dir: "s", floor: "level-1", rect: [-8, -15, -5, -9] },
      ],
    };
  };
  const edit = (p: VenuePlan, floor: "ground" | "level-1", f: (v: VenuePlan) => VenuePlan) => keepPairs(p, withFloor(p, floor, f(floorView(p, floor))));
  const rect = (p: VenuePlan, id: string) => p.fixtures.find((f) => f.id === id)!.rect;

  it("builds and walks a Level 1 room whose only way in is the stairs, with its door onto nothing left shut", () => {
    const built = buildVenueLayout(rooms, lone(), { eventName: "" });
    expect(built.planIssues).toEqual([]);
    expect(built.mode).toBe("drawn");
    expect(checkLayout(built.layout).ok).toBe(true);
  });

  it("still refuses a door onto nothing on the ground floor, and on Level 1 without stairs or a lift in the room", () => {
    const p = lone();
    expect(layoutFromPlan(rooms, { ...p, rooms: p.rooms.map((r) => (r.id === "hall-1" ? { ...r, door: { ...r.door, wall: "w" as const } } : r)) }, { eventName: "" }).issues).toContain("Hall 1: its door opens onto the outside. Move it to a wall that faces a walkway or another room.");
    const elsewhere = { ...twoFloors(), rooms: twoFloors().rooms.map((r) => (r.id === "hall-2" ? { ...r, door: { ...r.door, wall: "w" as const } } : r)) };
    expect(layoutFromPlan(rooms, elsewhere, { eventName: "" }).issues).toContain("Hall 2: its door opens onto the outside. Move it to a wall that faces a walkway or another room.");
  });

  it("moves, resizes and turns the other end of a joined stair with it", () => {
    const moved = edit(lone(), "level-1", (v) => moveTo(v, { kind: "fixture", id: "stairs-2" }, -10, -16, null));
    expect(rect(moved, "stairs-1")).toEqual(rect(moved, "stairs-2"));
    expect(rect(moved, "stairs-1")).toEqual([-10, -16, -7, -10]);
    const sized = edit(moved, "ground", (v) => setSize(v, { kind: "fixture", id: "stairs-1" }, 2.5, 5, null));
    expect(rect(sized, "stairs-2")).toEqual(rect(sized, "stairs-1"));
    const turned = edit(sized, "level-1", (v) => turn(v, { kind: "fixture", id: "stairs-2" }, null));
    expect(turned.fixtures.map((f) => f.dir)).toEqual(["w", "w"]);
    expect(rect(turned, "stairs-1")).toEqual(rect(turned, "stairs-2"));
    expect(planIssues(rooms, turned)).toEqual([]);
  });

  it("keeps the stairs joined when the room they stand in moves", () => {
    const moved = edit(lone(), "level-1", (v) => nudge(v, { kind: "room", id: "hall-2" }, 0, -2, null));
    expect(rect(moved, "stairs-1")).toEqual(rect(moved, "stairs-2"));
    expect(floorLinks(moved)).toHaveLength(1);
  });

  it("leaves the other end where it is when nothing on its floor would hold it there", () => {
    const p = lone();
    // Hall 1 ends at x = 1; the Main Corridor beyond it is on the ground floor too, so go past the building instead.
    const off = edit(p, "level-1", (v) => ({ ...v, rooms: v.rooms.map((r) => ({ ...r, rect: [-12, -20.5, 40, 0] as [number, number, number, number] })), fixtures: v.fixtures.map((f) => ({ ...f, rect: [30, -15, 33, -9] as [number, number, number, number] })) }));
    expect(rect(off, "stairs-1")).toEqual([-8, -15, -5, -9]);
  });

  // ── Review fixes, Oct 27 ──

  it("names the room upstairs and how to reach it in the AI attendees' venue description", () => {
    const l = layoutFromPlan(rooms, lone(), { eventName: "" }).layout;
    expect(describeVenue(l)).toContain("On Level 1, up the stairs from the Hall 1: Hall 2");
  });

  it("keeps each lift's own way of facing when the other end is only moved, and passes a turn on", () => {
    const p = twoFloors();
    p.fixtures[1] = { ...p.fixtures[1], dir: "n", rect: [9.4, -13.5, 12, -10.9] };
    const moved = edit(p, "ground", (v) => nudge(v, { kind: "fixture", id: "lift-1" }, -1, 0, null));
    expect(moved.fixtures.map((f) => f.dir)).toEqual(["w", "n"]);
    expect(rect(moved, "lift-2")).toEqual(rect(moved, "lift-1"));
  });

  it("says when the two ends no longer line up because one could not follow", () => {
    const p = lone();
    // Hall 1 below ends at x = 1; on Level 1 Hall 2 is widened so its stairs can go 2 m past that.
    const wide = { ...p, rooms: p.rooms.map((r) => (r.id === "hall-2" ? { ...r, rect: [-12, -20.5, 12, 0] as [number, number, number, number] } : r)), fixtures: p.fixtures.map((f) => ({ ...f, rect: [-3, -15, 0, -9] as [number, number, number, number] })) };
    const off = edit(wide, "level-1", (v) => nudge(v, { kind: "fixture", id: "stairs-2" }, 2, 0, null));
    expect(rect(off, "stairs-1")).toEqual([-3, -15, 0, -9]);
    expect(floorLinks(off)).toHaveLength(1);
    expect(planIssues(rooms, off)).toContain("Stairs on Level 1 is not exactly over the stairs under it. Move one back over the other; while both fit, moving one moves the other.");
  });

  it("joins each ground stair to one upper stair only, so moving one never drags another onto it", () => {
    const p = lone();
    p.fixtures.push({ id: "stairs-3", kind: "stairs", name: "", dir: "s", floor: "level-1", rect: [-6, -15, -3, -9] });
    expect(floorLinks(p).map((l) => l.upper.id)).toEqual(["stairs-2"]);
    const moved = edit(p, "ground", (v) => nudge(v, { kind: "fixture", id: "stairs-1" }, 0, 1, null));
    expect(rect(moved, "stairs-3")).toEqual([-6, -15, -3, -9]);
  });

  it("moves a room to the other floor beside the building without taking the stairs already there", () => {
    const p = lone();
    // Hall 1 goes up, where Hall 2 already stands in its place: it lands beside the building with its own stairs only.
    const up = toFloor(p, { kind: "room", id: "hall-1" }, "level-1", "foyer");
    expect(up.fixtures.find((f) => f.id === "stairs-2")!.rect).toEqual([-8, -15, -5, -9]);
    const hall1 = up.rooms.find((r) => r.id === "hall-1")!.rect;
    const s1 = up.fixtures.find((f) => f.id === "stairs-1")!;
    expect(s1.floor).toBe("level-1");
    expect(s1.rect[0]).toBeGreaterThanOrEqual(hall1[0]);
  });

  it("removes both ends of a joined stair, and only the one of an unjoined fixture", () => {
    expect(removeJoined(lone(), "stairs-2").fixtures).toEqual([]);
    expect(removeJoined(twoFloors(), "lift-1").fixtures).toEqual([]);
    const p = { ...lone(), fixtures: [...lone().fixtures, { id: "pillar-1", kind: "pillar" as const, name: "", dir: "n" as const, rect: [-11, -19, -10.2, -18.2] as [number, number, number, number] }] };
    expect(removeJoined(p, "pillar-1").fixtures.map((f) => f.id)).toEqual(["stairs-1", "stairs-2"]);
  });

  it("keeps a door shut only on a room with nothing beside it, and enters it at its stairs", () => {
    const view = floorView(lone(), "level-1");
    const { layout } = floorLayout(rooms, view, { eventName: "" });
    expect([...doorsLeftShut(view, layout)]).toEqual(["hall-2"]);
    const hall2 = layout.zones.find((z) => z.id === "hall-2")!;
    // Stairs at x -8..-5, z -15..-9, up the flight to the south: step out at the head, 1.4 m south of them.
    expect(hall2.spawn.slice(0, 2)).toEqual([-6.5, -7.6]);
    // With the upper walkway beside it again, its door onto the outside is wrong once more.
    const beside = { ...view, corridors: [{ id: "upper", floor: "level-1" as const, name: "Upper Corridor", rect: [1, -20.5, 12, 0] as [number, number, number, number] }], rooms: view.rooms.map((r) => ({ ...r, door: { ...r.door, wall: "w" as const } })) };
    expect(floorLayout(rooms, beside, { eventName: "" }).issues).toContain("Hall 2: its door opens onto the outside. Move it to a wall that faces a walkway or another room.");
  });
});
