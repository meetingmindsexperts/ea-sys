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
import { doorPoint, planIssues, type PlanDoor, type PlanWall, type VenuePlan } from "./plan";
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

export function layoutFromPlan(rooms: VenueRoom[], plan: VenuePlan, opts: { eventName: string }): PlanLayoutResult {
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
