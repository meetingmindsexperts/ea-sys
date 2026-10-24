/**
 * The floor plan editor's edits (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, phase 1):
 * every edit snaps to the grid, keeps the minimum size and the building limit,
 * and keeps each door on its wall. The end-to-end case: the congress template,
 * rearranged with these edits, is still a plan the venue can build and walk.
 */
import { describe, it, expect } from "vitest";
import { generateLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { PLAN_DOOR_MAX, PLAN_EXTENT, PLAN_MAX_WALKWAYS, PLAN_MIN_SIDE, planFromLayout, planIssues, planSchema, wallSpan, type VenuePlan } from "@/lib/venue/plan";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import {
  addWalkway,
  moveSnapped,
  nudge,
  resizeSnapped,
  canAddWalkway,
  spotBeside,
  fitDoor,
  keepListedRooms,
  moveTo,
  overlapping,
  placeRoom,
  rectOf,
  removeWalkway,
  resizeTo,
  setDoor,
  setSize,
  snap,
  tooSmall,
  turn,
  unplacedRooms,
  walkwayRect,
} from "@/lib/venue/plan-edit";
import { TEMPLATES, type VenueRoom } from "@/lib/venue/rooms";

const rooms: VenueRoom[] = TEMPLATES.congress.rooms.map((r) => ({ ...r }));
const start = (): VenuePlan => planFromLayout(generateLayout(rooms, { eventName: "" }));
const foyerId = rooms.find((r) => r.kind === "foyer")!.id;
const room = (p: VenuePlan, id: string) => p.rooms.find((r) => r.id === id)!;
const isNS = (w: string) => w === "n" || w === "s";
const builds = (p: VenuePlan) => {
  const shape = planIssues(rooms, p);
  if (shape.length) return shape;
  const built = layoutFromPlan(rooms, p, { eventName: "" });
  if (built.issues.length) return built.issues;
  return checkLayout(built.layout).issues;
};

describe("snap", () => {
  it("rounds to the 0.5 m grid", () => {
    expect(snap(1.24)).toBe(1);
    expect(snap(1.26)).toBe(1.5);
    expect(snap(-3.74)).toBe(-3.5);
  });
});

describe("moveTo", () => {
  it("moves a room with its door, snapped, keeping its size", () => {
    const p = start();
    const hall = p.rooms.find((r) => rooms.find((x) => x.id === r.id)!.kind === "hall")!;
    const next = moveTo(p, { kind: "room", id: hall.id }, hall.rect[0] - 40.2, hall.rect[1] + 0.1, foyerId);
    const moved = room(next, hall.id);
    expect(moved.rect[2] - moved.rect[0]).toBe(hall.rect[2] - hall.rect[0]);
    expect(moved.rect[3] - moved.rect[1]).toBe(hall.rect[3] - hall.rect[1]);
    expect(moved.rect[0]).toBe(snap(hall.rect[0] - 40.2));
    // An east or west door's position is a z, and it moves with the room's north edge.
    expect(moved.door.wall).toBe(hall.door.wall);
    expect(moved.door.at - hall.door.at).toBeCloseTo(moved.rect[1] - hall.rect[1]);
  });

  it("carries the entrance when the foyer moves", () => {
    const p = start();
    const f = room(p, foyerId);
    const next = moveTo(p, { kind: "room", id: foyerId }, f.rect[0] + 10, f.rect[1], foyerId);
    expect(next.entrance.at).toBeCloseTo(p.entrance.at + 10);
  });

  it("keeps an area inside the building limit", () => {
    const p = start();
    const next = moveTo(p, { kind: "room", id: foyerId }, PLAN_EXTENT * 3, PLAN_EXTENT * 3, foyerId);
    const r = room(next, foyerId).rect;
    expect(r[2]).toBeLessThanOrEqual(PLAN_EXTENT);
    expect(r[3]).toBeLessThanOrEqual(PLAN_EXTENT);
  });
});

describe("resizeTo", () => {
  it("never makes an area smaller than the minimum side", () => {
    const p = start();
    const c = p.corridors[0];
    const next = resizeTo(p, { kind: "corridor", id: c.id }, { e: true }, c.rect[0] - 50, 0, foyerId);
    const r = rectOf(next, { kind: "corridor", id: c.id })!;
    expect(r[2] - r[0]).toBe(PLAN_MIN_SIDE);
    expect(r[0]).toBe(c.rect[0]);
  });

  it("keeps the door on its wall when the room shrinks under it", () => {
    const p = start();
    const plenary = rooms.find((r) => r.kind === "plenary")!.id;
    const before = room(p, plenary);
    // Pull the east edge in to just past the west end: the door, on the south wall, must follow.
    const next = resizeTo(p, { kind: "room", id: plenary }, { e: true }, before.rect[0] + 6, 0, foyerId);
    const after = room(next, plenary);
    const [a0, a1] = wallSpan(after.rect, after.door.wall);
    expect(after.door.at - after.door.width / 2).toBeGreaterThanOrEqual(a0 - 1e-9);
    expect(after.door.at + after.door.width / 2).toBeLessThanOrEqual(a1 + 1e-9);
  });
});

describe("turn", () => {
  it("swaps width and depth about the centre and turns the door to the next wall clockwise", () => {
    const p = start();
    const hall = p.rooms.find((r) => r.door.wall === "e")!;
    const next = turn(p, { kind: "room", id: hall.id }, foyerId);
    const t = room(next, hall.id);
    expect(t.rect[2] - t.rect[0]).toBeCloseTo(hall.rect[3] - hall.rect[1], 0);
    expect(t.rect[3] - t.rect[1]).toBeCloseTo(hall.rect[2] - hall.rect[0], 0);
    expect(t.door.wall).toBe("s");
  });

  it("four turns bring a room back to where it started", () => {
    let p = start();
    const id = p.rooms[2].id;
    const orig = room(p, id);
    for (let i = 0; i < 4; i++) p = turn(p, { kind: "room", id }, foyerId);
    const back = room(p, id);
    expect(back.door.wall).toBe(orig.door.wall);
    expect(back.rect[2] - back.rect[0]).toBe(orig.rect[2] - orig.rect[0]);
    expect(back.rect[3] - back.rect[1]).toBe(orig.rect[3] - orig.rect[1]);
    expect(back.rect).toEqual(orig.rect);
    expect(back.door.at).toBeCloseTo(orig.door.at);
  });
});

describe("turn and move together (review HIGH)", () => {
  it("an odd-sized room turned, resized, turned again and moved stays on the grid and takes its door with it", () => {
    const id = "lounge";
    let p: VenuePlan = { ...start(), rooms: start().rooms.map((r) => (r.id === id ? { ...r, rect: [100, 0, 113.5, 10], door: { wall: "n", at: 104, width: 2.6 } } : r)) };
    p = turn(p, { kind: "room", id }, foyerId);
    p = resizeTo(p, { kind: "room", id }, { e: true }, room(p, id).rect[2] + 1.5, 0, foyerId);
    p = turn(p, { kind: "room", id }, foyerId);
    for (const v of room(p, id).rect) expect(Math.abs((v * 2) % 1)).toBe(0);
    const before = room(p, id);
    p = moveTo(p, { kind: "room", id }, before.rect[0] + 7.5, before.rect[1] + 3, foyerId);
    const after = room(p, id);
    const shift = isNS(after.door.wall) ? after.rect[0] - before.rect[0] : after.rect[1] - before.rect[1];
    expect(after.door.at - before.door.at).toBeCloseTo(shift);
  });

  it("four turns of an odd-sized room are exact, door included", () => {
    const id = "lounge";
    let p: VenuePlan = { ...start(), rooms: start().rooms.map((r) => (r.id === id ? { ...r, rect: [100, 0, 113.5, 10], door: { wall: "n", at: 104, width: 2.6 } } : r)) };
    const orig = room(p, id);
    for (let i = 0; i < 4; i++) {
      p = turn(p, { kind: "room", id }, foyerId);
      for (const v of room(p, id).rect) expect(Math.abs((v * 2) % 1)).toBe(0);
    }
    expect(room(p, id)).toEqual(orig);
  });
});

describe("setDoor", () => {
  it("moves a door to another wall at its middle, and keeps it inside the wall", () => {
    const p = start();
    const id = p.rooms[1].id;
    const r = room(p, id);
    const next = room(setDoor(p, id, { wall: "n" }), id);
    expect(next.door.wall).toBe("n");
    expect(next.door.at).toBeCloseTo((r.rect[0] + r.rect[2]) / 2);
    const far = room(setDoor(p, id, { wall: "n", at: r.rect[2] + 100 }), id);
    expect(far.door.at + far.door.width / 2).toBeCloseTo(r.rect[2]);
  });

  it("sets the entrance on the foyer, not the foyer's door", () => {
    const p = start();
    const next = setDoor(p, foyerId, { wall: "w" }, true);
    expect(next.entrance.wall).toBe("w");
    expect(room(next, foyerId).door).toEqual(room(p, foyerId).door);
  });

  it("fitDoor keeps a door within the schema's widest, even on a longer wall", () => {
    expect(fitDoor([0, 0, 80, 10], { wall: "n", at: 40, width: 50 }).width).toBe(PLAN_DOOR_MAX);
  });

  it("fitDoor narrows a door wider than its wall", () => {
    const d = fitDoor([0, 0, 4, 10], { wall: "n", at: 2, width: 9 });
    expect(d.width).toBe(4);
    expect(d.at).toBe(2);
  });
});

describe("walkways", () => {
  it("draws a walkway from a drag, snapped, and ignores a click", () => {
    expect(walkwayRect(0, 0, 0.3, 0.2)).toBeNull();
    expect(walkwayRect(10.2, 5.1, 0.1, 20.4)).toEqual([0, 5, 10, 20.5]);
    // A thin drag still makes a walkway at least the minimum side wide.
    const thin = walkwayRect(0, 0, 20, 1)!;
    expect(thin[3] - thin[1]).toBe(PLAN_MIN_SIDE);
  });

  it("adds walkways with free ids and removes them", () => {
    const p = start();
    const a = addWalkway(p, [100, 0, 106, 20])!;
    const b = addWalkway(a.plan, [110, 0, 116, 20])!;
    expect(a.id).not.toBe(b.id);
    expect(b.plan.corridors).toHaveLength(p.corridors.length + 2);
    expect(removeWalkway(b.plan, a.id).corridors.map((c) => c.id)).not.toContain(a.id);
  });

  it("stops at the most walkways a plan may hold, which the server's schema also refuses", () => {
    let p = start();
    while (canAddWalkway(p)) p = addWalkway(p, spotBeside(p, 6, 20))!.plan;
    expect(p.corridors).toHaveLength(PLAN_MAX_WALKWAYS);
    expect(addWalkway(p, [500, 0, 506, 20])).toBeNull();
    const over = { ...p, corridors: [...p.corridors, { id: "extra", name: "Extra", rect: [500, 0, 506, 20] as [number, number, number, number] }] };
    expect(planSchema.safeParse(over).error?.issues.map((i) => i.message)).toContain(`A plan has at most ${PLAN_MAX_WALKWAYS} walkways`);
  });
});

describe("rooms on the list and on the plan", () => {
  it("places a room added to the list beside the plan, without overlapping anything", () => {
    const more: VenueRoom[] = [...rooms, { id: "hall-x", name: "Hall X", kind: "hall", capacity: 80 }, { id: "hall-y", name: "Hall Y", kind: "hall", capacity: 80 }];
    let p = start();
    expect(unplacedRooms(p, more).map((r) => r.id)).toEqual(["hall-x", "hall-y"]);
    p = placeRoom(p, more, "hall-x");
    p = placeRoom(p, more, "hall-y");
    expect(unplacedRooms(p, more)).toHaveLength(0);
    expect(overlapping(p).size).toBe(0);
    // Stacked in one column beside the building, not marching further east each time.
    expect(room(p, "hall-y").rect[0]).toBe(room(p, "hall-x").rect[0]);
    expect(room(p, "hall-y").rect[1]).toBeGreaterThan(room(p, "hall-x").rect[3]);
  });

  it("drops rooms no longer on the list", () => {
    const p = start();
    const fewer = rooms.filter((r) => r.kind !== "lounge");
    expect(keepListedRooms(p, fewer).rooms).toHaveLength(fewer.length);
  });
});

describe("checks", () => {
  it("flags both areas that overlap", () => {
    const p = start();
    const [a, b] = p.rooms;
    const next = moveTo(p, { kind: "room", id: b.id }, a.rect[0], a.rect[1], foyerId);
    expect([...overlapping(next)]).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("warns, without refusing, when a room is drawn too small for its people", () => {
    const p = start();
    const plenary = rooms.find((r) => r.kind === "plenary")!.id;
    expect(tooSmall(p, rooms)).toEqual([]);
    const small = setSize(p, { kind: "room", id: plenary }, 12, 8, foyerId);
    expect(tooSmall(small, rooms)).toEqual([expect.stringContaining("drawn too small")]);
  });

  it("a congress plan changed with these edits still builds and is walkable, and a door onto the outside or a walkway to nowhere is refused", () => {
    let p = start();
    const lounge = rooms.find((r) => r.kind === "lounge")!.id;
    expect(builds(p)).toEqual([]);
    // The entrance moved to the foyer's west wall: still an outside wall, still walkable.
    p = setDoor(p, foyerId, { wall: "w" }, true);
    expect(builds(p)).toEqual([]);
    // A walkway drawn beside the building and the lounge moved onto it, door facing it.
    const east = Math.max(...p.rooms.map((r) => r.rect[2]));
    const lr = room(p, lounge).rect;
    expect(builds(setDoor(p, lounge, { wall: "e" })).join(" ")).toMatch(/opens onto the outside/);
    // A walkway outside that leads nowhere: the door is fine, but nobody can reach it, and the check says so.
    const withWalk = addWalkway(p, [east, lr[1], east + 6, lr[3]])!.plan;
    expect(builds(setDoor(withWalk, lounge, { wall: "e" }))).toEqual(expect.arrayContaining(["Walkway 2 cannot be reached from the entrance", "Networking Lounge cannot be reached from the entrance"]));
  });
});

describe("the foyer's own door (what the 3D banners flank)", () => {
  it("is the first door out of the foyer, even when a room listed before it opens into the foyer", () => {
    let p = start();
    // Hall A sits on the foyer's north wall: its door turned to its south wall opens into the foyer.
    const hallA = p.rooms.find((r) => r.id === "hall-a")!;
    expect(hallA.rect[3]).toBe(room(p, foyerId).rect[1]);
    p = setDoor(p, "hall-a", { wall: "s" });
    p = { ...p, rooms: [room(p, "hall-a"), ...p.rooms.filter((r) => r.id !== "hall-a")] };
    expect(builds(p)).toEqual([]);
    const doors = layoutFromPlan(rooms, p, { eventName: "" }).layout.doors.filter((d) => d.between[0] === foyerId);
    expect(doors.map((d) => d.between[1])).toEqual(["corridor", "hall-a"]);
  });
});

describe("snapping to other areas' edges and nudging (phase 2)", () => {
  // Two walkways side by side: B is off the grid at x 20.3, so only edge snapping can put A flush against it.
  const two = (): VenuePlan => ({
    ...start(),
    corridors: [
      { id: "a", name: "A", rect: [0, 0, 6, 20] },
      { id: "b", name: "B", rect: [20.3, 0, 26.3, 20] },
    ],
  });

  it("lines a moved area up with a nearby edge, off the grid if need be, and says where", () => {
    const { plan, guides } = moveSnapped(two(), { kind: "corridor", id: "a" }, 14.1, 0, foyerId);
    expect(rectOf(plan, { kind: "corridor", id: "a" })).toEqual([14.3, 0, 20.3, 20]);
    expect(guides.x).toEqual([20.3]);
  });

  it("leaves it on the grid when no edge is within reach", () => {
    const { plan, guides } = moveSnapped(two(), { kind: "corridor", id: "a" }, 10.2, 40, foyerId);
    expect(rectOf(plan, { kind: "corridor", id: "a" })![0]).toBe(10);
    expect(guides.x).toEqual([]);
  });

  it("snaps a dragged edge, not the others", () => {
    const { plan, guides } = resizeSnapped(two(), { kind: "corridor", id: "a" }, { e: true }, 19.9, 0, foyerId);
    expect(rectOf(plan, { kind: "corridor", id: "a" })).toEqual([0, 0, 20.3, 20]);
    expect(guides).toEqual({ x: [20.3], z: [] });
  });

  it("shows no guide where the minimum size held the edge back", () => {
    const p: VenuePlan = { ...two(), corridors: [{ id: "a", name: "A", rect: [0, 0, 6, 20] }, { id: "b", name: "B", rect: [1.2, 30, 8, 40] }] };
    const { plan, guides } = resizeSnapped(p, { kind: "corridor", id: "a" }, { e: true }, 1.1, 0, foyerId);
    expect(rectOf(plan, { kind: "corridor", id: "a" })![2]).toBe(3);
    expect(guides.x).toEqual([]);
  });

  it("nudges by exactly the step, keeping an off-grid offset, door and all", () => {
    const p = two();
    const moved = nudge(p, { kind: "corridor", id: "b" }, 0.5, -5, foyerId);
    expect(rectOf(moved, { kind: "corridor", id: "b" })).toEqual([20.8, -5, 26.8, 15]);
    const lounge = room(p, "lounge");
    const after = room(nudge(p, { kind: "room", id: "lounge" }, 0.5, 0, foyerId), "lounge");
    const shift = isNS(after.door.wall) ? 0.5 : 0;
    expect(after.door.at - lounge.door.at).toBeCloseTo(shift);
  });
});
