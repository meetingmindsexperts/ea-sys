/**
 * The building a drawn plan makes (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 3.2): the same `VenueLayout` the template makes, so the plan view,
 * the PDF, the walkability check and the walkable venue need no second path.
 *
 * - Zones are the drawn rectangles (rooms and walkways).
 * - Walls are found, not drawn: wherever two different areas meet, or an area
 *   meets the outside, there is a wall; two walkways that meet are one open
 *   space. A door cuts an opening in its wall; the entrance is glass.
 * - Each room is furnished by the template's own furnishers, from its door.
 *
 * Client-safe: pure, no Node imports.
 */
import {
  CEIL,
  ENTRY,
  FLOOR,
  HALL_TINTS,
  SUB,
  frame,
  furnishZone,
  generateLayout,
  r2,
  type Footprint,
  type FrameDoor,
  type LayoutDoor,
  type LayoutItem,
  type LayoutWall,
  type LayoutZone,
  type Out,
  type Rect,
  type VenueLayout,
  type WallOpening,
} from "./layout";
import {
  FIXTURE_INFO,
  FLOOR_NAME,
  doorPoint,
  floorLinks,
  floorOf,
  floorView,
  planFloors,
  planIssues,
  type PlanDoor,
  type PlanFixture,
  type PlanFloor,
  type PlanWall,
  type VenuePlan,
} from "./plan";
import type { VenueRoom } from "./rooms";

const EPS = 0.01;
const PROBE = 0.05;
/** Outside walls stand taller than any room. */
const EXTERIOR_H = 9;
/** A wide door (the foyer's way on, the plenary's) gets a lintel; a room door is full height. */
const LINTEL = 4.4;
const ENTRANCE_LINTEL = 6.2;

const FRAME_OF: Record<PlanWall, FrameDoor> = { n: "north", s: "south", e: "east", w: "west" };
/** Into the room from a door in this wall, and the yaw that looks that way ((sin, cos) of yaw). */
const INWARD: Record<PlanWall, { dx: number; dz: number; yaw: number }> = {
  n: { dx: 0, dz: 1, yaw: 0 },
  s: { dx: 0, dz: -1, yaw: Math.PI },
  w: { dx: 1, dz: 0, yaw: Math.PI / 2 },
  e: { dx: -1, dz: 0, yaw: -Math.PI / 2 },
};

export interface PlanLayoutResult {
  layout: VenueLayout;
  /** Problems the geometry shows (a door onto the outside, an entrance into a room). */
  issues: string[];
}

const inside = (r: Rect, x: number, z: number) => x > r[0] && x < r[2] && z > r[1] && z < r[3];

/** Where across a room (its frame's u) a point lies. */
function uOf(door: FrameDoor, origin: [number, number], x: number, z: number): number {
  if (door === "south") return x - origin[0];
  if (door === "north") return origin[0] - x;
  if (door === "east") return z - origin[1];
  return origin[1] - z;
}

/**
 * The building a plan makes. A plan on one floor builds exactly as it always did. A plan with a Level 1
 * builds each floor on its own, then stands Level 1 beside the ground floor in the walkable venue's one flat
 * world (`FLOOR_GAP` apart, so the two never meet), joined by a "floor" hotspot at each linked stair and lift.
 */
export function layoutFromPlan(rooms: VenueRoom[], plan: VenuePlan, opts: { eventName: string }): PlanLayoutResult {
  const floors = planFloors(plan);
  if (floors.length === 1) return floorLayout(rooms, floorView(plan, "ground"), opts);
  const built = floors.map((f) => ({ floor: f, ...floorLayout(rooms, floorView(plan, f), opts) }));
  const [ground, upper] = built;
  const dx = r2(ground.layout.bounds[2] + FLOOR_GAP - upper.layout.bounds[0]);
  const shift: Record<PlanFloor, number> = { ground: 0, "level-1": dx };
  // Stands are numbered on through the floors (Level 1's go on from the ground floor's), since stand n
  // carries the nth sponsor and the venue counts visits by stand: two Stand 1s would share both (review MED).
  const groundStands = ground.layout.items.filter((it) => it.t === "stand").length;
  const parts = built.map((b) => ({ floor: b.floor, layout: shiftLayout(numberStandsFrom(b.layout, b.floor === "ground" ? 0 : groundStands), shift[b.floor], b.floor) }));

  // A stair or lift is taken from in front of it, in the area that holds it: one facing a wall would put
  // that spot in the next room, or outside (review MED).
  const issues: string[] = [];
  for (const { lower, upper: up } of floorLinks(plan)) {
    for (const [f, floor] of [[lower, "ground"], [up, "level-1"]] as const) {
      if (landsInside(plan, f, floor)) continue;
      issues.push(`${f.name || FIXTURE_INFO[f.kind].label} on ${FLOOR_NAME[floor]}: there is no floor in front of it to step out onto. Turn it, or move it away from the wall.`);
    }
  }

  // A hotspot at each end of every stair and lift, taking you to the other end.
  const hotspots = floorLinks(plan).flatMap(({ lower, upper: up }) => {
    const a = landing(lower, "ground", shift.ground);
    const b = landing(up, "level-1", shift["level-1"]);
    const what = lower.kind === "lift" ? "the lift" : "the stairs";
    return [
      { id: `floor-${lower.id}`, x: a[0], z: a[1], r: 2, kind: "floor" as const, prompt: `Take ${what} up to ${FLOOR_NAME["level-1"]}`, title: `${lower.name || FIXTURE_INFO[lower.kind].label} to ${FLOOR_NAME["level-1"]}`, body: "", to: b },
      { id: `floor-${up.id}`, x: b[0], z: b[1], r: 2, kind: "floor" as const, prompt: `Take ${what} down to the ${FLOOR_NAME.ground} floor`, title: `${up.name || FIXTURE_INFO[up.kind].label} to the ${FLOOR_NAME.ground} floor`, body: "", to: a },
    ];
  });

  const all = parts.map((p) => p.layout);
  const bounds: Rect = [Math.min(...all.map((l) => l.bounds[0])), Math.min(...all.map((l) => l.bounds[1])), Math.max(...all.map((l) => l.bounds[2])), Math.max(...all.map((l) => l.bounds[3]))];
  return {
    layout: {
      v: 1,
      bounds,
      zones: all.flatMap((l) => l.zones),
      walls: all.flatMap((l) => l.walls),
      doors: all.flatMap((l) => l.doors),
      items: all.flatMap((l) => l.items),
      people: all.flatMap((l) => l.people),
      hotspots: [...all.flatMap((l) => l.hotspots), ...hotspots],
      routes: all.flatMap((l) => l.routes),
      levels: parts.map((p) => ({ id: p.floor, name: FLOOR_NAME[p.floor], bounds: p.layout.bounds })),
    },
    issues: [...built.flatMap((b) => b.issues), ...issues],
  };
}

/** A floor's stands numbered on from `from`, with their visit points; unchanged when `from` is 0. */
function numberStandsFrom(l: VenueLayout, from: number): VenueLayout {
  if (!from) return l;
  const n = (k: number) => k + from;
  const items = l.items.map((it) => (it.t === "stand" ? { ...it, n: n(it.n), label: `Stand ${n(it.n)}`, tier: n(it.n) <= 2 ? 1 : 2 } : it));
  const hotspots = l.hotspots.map((h) => {
    if (h.kind !== "stand") return h;
    const k = n(Number(h.id.replace("stand-", "")));
    return { ...h, id: `stand-${k}`, prompt: `Visit Stand ${k}`, title: `Stand ${k}` };
  });
  return { ...l, items, hotspots };
}

/** Whether the spot in front of a stair or lift, where people take it, lies on the floor of the area that holds it. */
function landsInside(plan: VenuePlan, f: PlanFixture, floor: PlanFloor): boolean {
  const [x, z] = landing(f, floor, 0);
  const view = floorView(plan, floor);
  const host = [...view.rooms, ...view.corridors].find((a) => f.rect[0] >= a.rect[0] - EPS && f.rect[1] >= a.rect[1] - EPS && f.rect[2] <= a.rect[2] + EPS && f.rect[3] <= a.rect[3] + EPS);
  return !!host && inside(host.rect, x, z);
}

/** How far apart, east to west, the floors stand in the walkable venue's world, in metres. */
const FLOOR_GAP = 30;
/** How far in front of a stair or lift a person stands to take it, and steps out when they arrive. */
const LANDING = 1.4;

/**
 * Where a person takes a stair or lift, and where they step out on arriving: in front of a lift's doors;
 * at the foot of the stairs on the ground floor and at their head on Level 1 (the arrow points up the
 * flight). They face away from it, into the room.
 */
function landing(f: PlanFixture, floor: PlanFloor, dx: number): [number, number, number] {
  const [x0, z0, x1, z1] = f.rect;
  const out: PlanWall = f.kind === "stairs" && floor === "ground" ? OPPOSITE[f.dir] : f.dir;
  const step = INWARD[OPPOSITE[out]];
  const x = beyond(out === "e", out === "w", x0, x1);
  const z = beyond(out === "s", out === "n", z0, z1);
  return [r2(x + dx), r2(z), r2(Math.atan2(step.dx, step.dz))];
}
const OPPOSITE: Record<PlanWall, PlanWall> = { n: "s", s: "n", e: "w", w: "e" };
/** Along one axis: `LANDING` past the far side, or the near side, or the middle when the way out runs along the other axis. */
function beyond(far: boolean, near: boolean, lo: number, hi: number): number {
  if (far) return hi + LANDING;
  if (near) return lo - LANDING;
  return (lo + hi) / 2;
}

const shiftFoot = (f: Footprint, dx: number): Footprint => ("r" in f ? { ...f, cx: r2(f.cx + dx) } : { ...f, x0: r2(f.x0 + dx), x1: r2(f.x1 + dx) });

/** A floor's building moved `dx` metres east, its zones marked with the floor they are on. */
function shiftLayout(l: VenueLayout, dx: number, floor: PlanFloor): VenueLayout {
  const X = (x: number) => r2(x + dx);
  const items = l.items.map((it) => {
    const o: LayoutItem = { ...it, foot: shiftFoot(it.foot, dx) };
    if ("x" in o) o.x = X(o.x);
    if ("cx" in o) o.cx = X(o.cx);
    if ("p0" in o) Object.assign(o, { p0: [X(o.p0[0]), o.p0[1]], p1: [X(o.p1[0]), o.p1[1]] });
    return o;
  });
  return {
    v: 1,
    bounds: [X(l.bounds[0]), l.bounds[1], X(l.bounds[2]), l.bounds[3]],
    zones: l.zones.map((z) => ({ ...z, rect: [X(z.rect[0]), z.rect[1], X(z.rect[2]), z.rect[3]], spawn: [X(z.spawn[0]), z.spawn[1], z.spawn[2]], level: floor })),
    // A wall along x runs, and opens, along x; one along z stands at an x.
    walls: l.walls.map((w) => (w.axis === "x" ? { ...w, a0: X(w.a0), a1: X(w.a1), opens: w.opens.map((o) => ({ ...o, a: X(o.a), b: X(o.b) })) } : { ...w, k: X(w.k) })),
    doors: l.doors.map((d) => ({ ...d, x: X(d.x) })),
    items,
    people: l.people.map((p) => ({ ...p, x: X(p.x) })),
    hotspots: l.hotspots.map((h) => ({ ...h, x: X(h.x) })),
    routes: l.routes.map((r) => r.map(([x, z]) => [X(x), z] as [number, number])),
  };
}

/** One floor's building: the rooms, walkways and fixtures of a plan that is all on one floor (`floorView`). */
export function floorLayout(rooms: VenueRoom[], plan: VenuePlan, opts: { eventName: string }): PlanLayoutResult {
  const issues: string[] = [];
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const placed = plan.rooms.filter((p) => byId.has(p.id));
  const foyerP = placed.find((p) => byId.get(p.id)!.kind === "foyer");
  const doorOf = new Map(placed.map((p) => [p.id, p.door]));

  // ── Zones: the foyer, the walkways, then the rooms in drawing order ──
  const zones: LayoutZone[] = [];
  let hallN = 0;
  const roomZone = (id: string, rect: Rect, spawn: [number, number, number]): LayoutZone => {
    const room = byId.get(id)!;
    const tint = room.kind === "hall" ? HALL_TINTS[hallN++ % HALL_TINTS.length] : undefined;
    return {
      id, name: room.name, sub: SUB[room.kind], kind: room.kind, rect: rect.map(r2) as Rect, ceil: CEIL[room.kind],
      spawn: spawn.map(r2) as [number, number, number], floor: FLOOR[room.kind], capacity: room.capacity, ...(tint && { tint }),
    };
  };
  if (foyerP) zones.push(roomZone(foyerP.id, foyerP.rect, foyerSpawn(foyerP.rect, foyerP.door, plan.entrance)));
  for (const c of plan.corridors) {
    const cx = (c.rect[0] + c.rect[2]) / 2;
    zones.push({ id: c.id, name: c.name, sub: SUB.corridor, kind: "corridor", rect: c.rect.map(r2) as Rect, ceil: CEIL.corridor, spawn: [r2(cx), r2(c.rect[3] - 2), r2(Math.PI)], floor: "marble", capacity: 0 });
  }
  for (const p of placed) {
    if (p === foyerP) continue;
    const [dx, dz] = doorPoint(p.rect, p.door);
    const into = INWARD[p.door.wall];
    zones.push(roomZone(p.id, p.rect, [dx + into.dx * ENTRY, dz + into.dz * ENTRY, into.yaw]));
  }
  const zoneAt = (x: number, z: number) => zones.find((zn) => inside(zn.rect, x, z));

  // ── Doors: each room's, onto whatever is on the other side ──
  // The foyer is the first zone, so its own door is the first door out of the foyer; the 3D venue's banners
  // (world.js) flank that one, and a room whose door opens into the foyer comes after it (venue-plan-edit.test.ts).
  const doors: LayoutDoor[] = [];
  for (const zn of zones) {
    const d = doorOf.get(zn.id);
    if (!d) continue;
    const [x, z] = doorPoint(zn.rect, d);
    const into = INWARD[d.wall];
    const other = zoneAt(x - into.dx * PROBE * 10, z - into.dz * PROBE * 10);
    if (!other) {
      issues.push(`${zn.name}: its door opens onto the outside. Move it to a wall that faces a walkway or another room.`);
      continue;
    }
    const axis = d.wall === "n" || d.wall === "s" ? "x" : "z";
    const between: [string, string] = zn.kind === "foyer" ? [zn.id, other.id] : [other.id, zn.id];
    doors.push({ x: r2(x), z: r2(z), width: d.width, axis, between });
  }

  // ── Walls: wherever two different areas meet, or an area meets the outside ──
  const walls = findWalls(zones);
  for (const d of doors) {
    const along = d.axis === "x" ? d.x : d.z;
    const k = d.axis === "x" ? d.z : d.x;
    const w = walls.find((wl) => wl.axis === d.axis && Math.abs(wl.k - k) < EPS && along > wl.a0 - EPS && along < wl.a1 + EPS);
    if (!w) {
      issues.push(`The door between ${nameOf(zones, d.between[0])} and ${nameOf(zones, d.between[1])} is not in a wall`);
      continue;
    }
    w.opens.push(opening(along, d.width, d.width > 4 ? LINTEL : undefined));
  }
  if (foyerP) {
    const [ex, ez] = doorPoint(foyerP.rect, plan.entrance);
    const into = INWARD[plan.entrance.wall];
    if (zoneAt(ex - into.dx * PROBE * 10, ez - into.dz * PROBE * 10)) {
      issues.push("The entrance opens into another room. Put it on an outside wall of the foyer.");
    } else {
      const axis = plan.entrance.wall === "n" || plan.entrance.wall === "s" ? "x" : "z";
      const k = axis === "x" ? ez : ex;
      const w = walls.find((wl) => wl.axis === axis && Math.abs(wl.k - k) < EPS && plan.entrance.at > wl.a0 - EPS && plan.entrance.at < wl.a1 + EPS);
      if (w) w.opens.push({ ...opening(plan.entrance.at, plan.entrance.width, ENTRANCE_LINTEL), glass: true });
    }
  }

  // ── Furniture, signs and the crowd's loops ──
  const out: Out = { items: [], people: [], hotspots: [] };
  for (const zn of zones) {
    if (zn.kind === "corridor") continue;
    const d = zn.kind === "foyer" ? plan.entrance : doorOf.get(zn.id);
    if (!d) continue;
    const fd = FRAME_OF[d.wall];
    furnishZone(zn, fd, out, { lineU: foyerLineU(zn, fd, doorOf.get(zn.id)), eventName: opts.eventName });
  }
  for (const d of doors) out.items.push(...doorSign(zones, d));
  placeFixtures(plan, zones, out);

  const routes: [number, number][][] = [];
  for (const zn of zones) if (zn.kind === "corridor") routes.push(corridorLoop(zn.rect));
  const foyerZone = zones.find((zn) => zn.kind === "foyer");
  if (foyerZone && foyerP) routes.push(foyerLoop(foyerZone, FRAME_OF[plan.entrance.wall], foyerLineU(foyerZone, FRAME_OF[plan.entrance.wall], foyerP.door)));

  const bounds: Rect = zones.length
    ? [Math.min(...zones.map((zn) => zn.rect[0])), Math.min(...zones.map((zn) => zn.rect[1])), Math.max(...zones.map((zn) => zn.rect[2])), Math.max(...zones.map((zn) => zn.rect[3]))]
    : [0, 0, 0, 0];

  return {
    layout: { v: 1, bounds: bounds.map(r2) as Rect, zones, walls, doors, items: out.items, people: out.people, hotspots: out.hotspots, routes },
    issues,
  };
}

/** The yaw that faces each way, as the furnishers use it: (sin, cos) of yaw is the direction, +z south. */
const FACING: Record<PlanWall, number> = { n: r2(Math.PI), s: 0, e: r2(Math.PI / 2), w: r2(-Math.PI / 2) };

const boxOf = (f: Footprint): Rect => ("r" in f ? [f.cx - f.r, f.cz - f.r, f.cx + f.r, f.cz + f.r] : [f.x0, f.z0, f.x1, f.z1]);
const hits = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** Room kept around a solid fixture: furniture nearer than this would leave no way past. */
const FIXTURE_CLEARANCE = 0.3;

/**
 * The plan's fixtures as items in the room or walkway that holds them. The
 * furnishers do not know about fixtures, so the furniture, people and stand
 * points a solid fixture stands on (or crowds) are dropped, and the stands
 * left are numbered again from 1, since stand n carries the nth sponsor.
 */
function placeFixtures(plan: VenuePlan, zones: LayoutZone[], out: Out) {
  const placed: { f: PlanFixture; zone: LayoutZone }[] = [];
  for (const f of plan.fixtures) {
    const zone = zones.find((z) => f.rect[0] >= z.rect[0] - EPS && f.rect[1] >= z.rect[1] - EPS && f.rect[2] <= z.rect[2] + EPS && f.rect[3] <= z.rect[3] + EPS);
    if (!zone) continue;
    placed.push({ f, zone });
    const info = FIXTURE_INFO[f.kind];
    const [x0, z0, x1, z1] = f.rect.map(r2);
    if (info.solid) {
      const keep: Rect = [x0 - FIXTURE_CLEARANCE, z0 - FIXTURE_CLEARANCE, x1 + FIXTURE_CLEARANCE, z1 + FIXTURE_CLEARANCE];
      const covered = (it: LayoutItem) => it.zone === zone.id && it.t !== "fixture" && it.t !== "sign" && it.t !== "screen" && hits(boxOf(it.foot), keep);
      // A registration counter put over one of the foyer's own desks takes that desk's place: its staff and its
      // prompt go with it (Oct 26). Any other fixture only clears the floor it stands on, as before.
      if (f.kind === "registration") {
        for (const d of out.items.filter((it): it is Extract<LayoutItem, { t: "desk" }> => it.t === "desk" && it.zone === zone.id && hits(boxOf(it.foot), [x0, z0, x1, z1]))) {
          const [dx0, dz0, dx1, dz1] = boxOf(d.foot);
          out.people = out.people.filter((p) => p.role !== "staff" || !inside([dx0 - 1.5, dz0 - 1.5, dx1 + 1.5, dz1 + 1.5], p.x, p.z));
          out.hotspots = out.hotspots.filter((h) => h.id !== d.title);
        }
      }
      out.items = out.items.filter((it) => !covered(it));
      out.people = out.people.filter((p) => !hits([p.x - 0.3, p.z - 0.3, p.x + 0.3, p.z + 0.3], keep));
      const blocked = out.hotspots.filter((h) => hits([h.x - 0.5, h.z - 0.5, h.x + 0.5, h.z + 0.5], keep));
      out.hotspots = out.hotspots.filter((h) => !blocked.includes(h));
      // A stand whose visit point the fixture covers goes too: it could not be visited, yet would show a sponsor.
      const lost = new Set(blocked.filter((h) => h.kind === "stand").map((h) => h.id));
      out.items = out.items.filter((it) => it.t !== "stand" || !lost.has(`stand-${it.n}`));
    }
    const down = f.kind === "stairs" && floorOf(f) !== "ground";
    out.items.push({ t: "fixture", zone: zone.id, solid: info.solid, foot: { x0, z0, x1, z1 }, kind: f.kind, name: f.name || info.label, yaw: FACING[f.dir], ...(down && { down }) });
  }
  // Staff and prompts only once every fixture stands, so none lands on a fixture listed after it (review LOW).
  const solids = placed.filter(({ f }) => FIXTURE_INFO[f.kind].solid).map(({ f }) => f.rect);
  for (const { f, zone } of placed) serveFixture(f, f.name || FIXTURE_INFO[f.kind].label, zone.rect, solids, out);
  renumberStands(out);
}

/**
 * Who works at a fixture and what a visitor can do there: a registration counter is staffed and hands out
 * badges, a photo wall takes a photo. Both from the side it faces (the guests' side); staff stand behind.
 */
function serveFixture(f: PlanFixture, name: string, room: Rect, solids: Rect[], out: Out) {
  if (f.kind !== "registration" && f.kind !== "photo-wall") return;
  const [x0, z0, x1, z1] = f.rect;
  const into = INWARD[OPPOSITE[f.dir]];
  const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
  const half = into.dx ? (x1 - x0) / 2 : (z1 - z0) / 2;
  const front: [number, number] = [r2(cx + into.dx * (half + 1.5)), r2(cz + into.dz * (half + 1.5))];
  if (f.kind === "photo-wall") {
    // `face`: the photo is taken facing away from the wall, so the camera stands in front and the wall is behind you.
    out.hotspots.push({ id: `photo-${f.id}`, x: front[0], z: front[1], r: 2.2, kind: "info", prompt: "Take a photo here", title: name, body: "", action: "photo", face: FACING[f.dir] });
    return;
  }
  // Staff along the back, about one per three metres of counter, facing the guests.
  const along = into.dx ? z1 - z0 : x1 - x0;
  const staff = Math.max(1, Math.round(along / 3));
  for (let i = 0; i < staff; i++) {
    const t = (i + 0.5) / staff;
    const [px, pz] = into.dx ? [cx - into.dx * (half + 0.7), z0 + t * along] : [x0 + t * along, cz - into.dz * (half + 0.7)];
    // A counter against a wall has no room behind it: no one stands in the wall, or in another fixture.
    const clear = !solids.some((r) => hits([px - 0.3, pz - 0.3, px + 0.3, pz + 0.3], r));
    if (inside(room, px, pz) && clear) out.people.push({ x: r2(px), z: r2(pz), yaw: r2(Math.atan2(into.dx, into.dz)), pose: "stand", role: "staff" });
  }
  out.hotspots.push({ id: `desk-${f.id}`, x: front[0], z: front[1], r: 3, kind: "info", prompt: "Collect your badge", title: name, body: "Delegates collect their badges here." });
}

/** Stands numbered 1, 2, 3 in order again, with their visit points, after some were dropped. */
function renumberStands(out: Out) {
  const stands = out.items.filter((it): it is Extract<LayoutItem, { t: "stand" }> => it.t === "stand");
  const kept = new Set(stands.map((s) => `stand-${s.n}`));
  out.hotspots = out.hotspots.filter((h) => h.kind !== "stand" || kept.has(h.id));
  const next = new Map(stands.map((s, i) => [s.n, i + 1]));
  for (const s of stands) {
    const n = next.get(s.n)!;
    // As the exhibition furnisher numbers them: the first two stands are the larger tier.
    Object.assign(s, { n, label: `Stand ${n}`, tier: n <= 2 ? 1 : 2 });
  }
  for (const h of out.hotspots) {
    if (h.kind !== "stand") continue;
    const n = next.get(Number(h.id.replace("stand-", "")));
    if (!n) continue;
    h.id = `stand-${n}`;
    h.prompt = `Visit Stand ${n}`;
    h.title = `Stand ${n}`;
  }
}

const nameOf = (zones: LayoutZone[], id: string) => zones.find((z) => z.id === id)?.name ?? id;

function opening(along: number, width: number, y1?: number): WallOpening {
  return { a: r2(along - width / 2), b: r2(along + width / 2), ...(y1 !== undefined && { y1 }) };
}

/** The foyer's spawn: three metres in from the entrance, on the line to its way on when that faces the entrance. */
function foyerSpawn(rect: Rect, door: PlanDoor, entrance: PlanDoor): [number, number, number] {
  const into = INWARD[entrance.wall];
  const [ex, ez] = doorPoint(rect, entrance);
  const facing = (entrance.wall === "n" || entrance.wall === "s") === (door.wall === "n" || door.wall === "s");
  const along = facing ? door.at : entrance.at;
  if (entrance.wall === "n" || entrance.wall === "s") return [along, ez + into.dz * 3, into.yaw];
  return [ex + into.dx * 3, along, into.yaw];
}

/** Where, across the foyer from its entrance, its way on into the building starts. */
function foyerLineU(zn: LayoutZone, fd: FrameDoor, door: PlanDoor | undefined): number {
  if (zn.kind !== "foyer" || !door) return 0;
  const [x, z] = doorPoint(zn.rect, door);
  return uOf(fd, frame(zn, fd).at(0, 0), x, z);
}

/** The crowd's loop along a walkway: up and down its length. */
function corridorLoop(rect: Rect): [number, number][] {
  const [x0, z0, x1, z1] = rect;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  if (x1 - x0 > z1 - z0 && z1 - z0 < 6) return loop(x0 + 2, cz - 1.2, x1 - 1.5, cz + 1.2);
  return loop(cx - 1.2, z0 + 2, cx + 1.2, z1 - 1.5);
}

/** The crowd's loop in front of the foyer's desks, twelve metres across its way on. */
function foyerLoop(zn: LayoutZone, fd: FrameDoor, lineU: number): [number, number][] {
  const f = frame(zn, fd);
  const a = f.at(lineU - 6, 3);
  const b = f.at(lineU + 6, f.D * 0.5 - 2.5);
  return loop(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
}

const loop = (x0: number, z0: number, x1: number, z1: number): [number, number][] =>
  [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => [r2(x), r2(z)] as [number, number]);

/** The sign over a room's door, on the side people approach from. */
function doorSign(zones: LayoutZone[], d: LayoutDoor): LayoutItem[] {
  const room = zones.find((z) => z.id === d.between[1]);
  if (!room || room.kind === "corridor") return [];
  const rcx = (room.rect[0] + room.rect[2]) / 2;
  const rcz = (room.rect[1] + room.rect[3]) / 2;
  if (d.axis === "z") {
    const roomWest = rcx < d.x;
    return [{
      t: "sign", zone: d.between[0], solid: false, foot: { x0: d.x - 0.1, z0: d.z - 2, x1: d.x + 0.1, z1: d.z + 2 },
      x: r2(d.x + (roomWest ? 0.18 : -0.18)), y: 4.1, z: d.z, w: 4.4, hgt: 0.9, yaw: roomWest ? r2(Math.PI / 2) : r2(-Math.PI / 2), kicker: "", title: room.name, sub: room.sub,
    }];
  }
  const roomNorth = rcz < d.z;
  const main = room.kind === "plenary";
  return [{
    t: "sign", zone: d.between[0], solid: false, foot: { x0: d.x - 3, z0: d.z - 0.1, x1: d.x + 3, z1: d.z + 0.1 },
    x: d.x, y: main ? 4.7 : 4.1, z: r2(d.z + (roomNorth ? 0.18 : -0.18)), w: main ? 7 : 4.4, hgt: main ? 1.2 : 0.9, yaw: roomNorth ? 0 : r2(Math.PI),
    kicker: main ? "Main stage" : "", title: room.name, sub: room.sub,
  }];
}

/**
 * The walls of a set of rectangles. Every line some rectangle edge lies on is
 * cut at every other edge's coordinate; each piece is a wall when the areas
 * on its two sides differ (or one side is outside) and they are not both
 * walkways. Consecutive wall pieces join into one wall.
 */
export function findWalls(zones: LayoutZone[]): LayoutWall[] {
  const xs = [...new Set(zones.flatMap((z) => [z.rect[0], z.rect[2]]))].sort((a, b) => a - b);
  const zs = [...new Set(zones.flatMap((z) => [z.rect[1], z.rect[3]]))].sort((a, b) => a - b);
  const at = (x: number, z: number) => zones.find((zn) => inside(zn.rect, x, z));
  const walls: LayoutWall[] = [];
  const scan = (axis: "x" | "z", k: number, cuts: number[]) => {
    let run: { a0: number; a1: number; h: number } | null = null;
    const flush = () => {
      if (run) walls.push({ axis, k: r2(k), a0: r2(run.a0), a1: r2(run.a1), h: run.h, opens: [] });
      run = null;
    };
    for (let i = 0; i + 1 < cuts.length; i++) {
      const m = (cuts[i] + cuts[i + 1]) / 2;
      const [a, b] = axis === "x" ? [at(m, k - PROBE), at(m, k + PROBE)] : [at(k - PROBE, m), at(k + PROBE, m)];
      const isWall = a?.id !== b?.id && !(a?.kind === "corridor" && b?.kind === "corridor");
      if (!isWall) {
        flush();
        continue;
      }
      const h = !a || !b ? EXTERIOR_H : Math.max(a.ceil, b.ceil);
      if (run) {
        run.a1 = cuts[i + 1];
        run.h = Math.max(run.h, h);
      } else run = { a0: cuts[i], a1: cuts[i + 1], h };
    }
    flush();
  };
  for (const k of zs) scan("x", k, xs);
  for (const k of xs) scan("z", k, zs);
  return walls;
}


export interface BuiltVenueLayout {
  layout: VenueLayout;
  mode: "automatic" | "drawn";
  /** Why a saved plan was not used (it no longer fits the room list); empty when it was, or when there is none. */
  planIssues: string[];
}

/**
 * The one way to build an event's venue: its drawn plan when it has one that
 * still fits the room list and builds cleanly, else the automatic template.
 * A plan that no longer fits (a room added since it was drawn) never breaks
 * the venue: it falls back to automatic, and the reasons travel with it so
 * the Venue tab can say what to fix.
 */
export function buildVenueLayout(rooms: VenueRoom[], plan: VenuePlan | null, opts: { eventName: string }): BuiltVenueLayout {
  if (!plan) return { layout: generateLayout(rooms, opts), mode: "automatic", planIssues: [] };
  const shape = planIssues(rooms, plan);
  if (shape.length) return { layout: generateLayout(rooms, opts), mode: "automatic", planIssues: shape };
  const built = layoutFromPlan(rooms, plan, opts);
  if (built.issues.length) return { layout: generateLayout(rooms, opts), mode: "automatic", planIssues: built.issues };
  return { layout: built.layout, mode: "drawn", planIssues: [] };
}
