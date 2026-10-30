/**
 * The floor plan editor's edits (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, 3.5):
 * pure functions from one plan to the next, so the canvas, the side panel and
 * undo all go through the same few rules and the tests can pin them.
 *
 * Every edit keeps each area on the 0.5 m grid, keeps each area at least
 * PLAN_MIN_SIDE each way and inside PLAN_EXTENT, and keeps each door on its
 * wall (a door never ends up in the air because its room shrank). A room
 * carries its door with it; the foyer also carries the entrance.
 *
 * Client-safe: pure, no Node imports.
 */
import { clamp, fits, generateLayout, r2, type Rect } from "./layout";
import {
  FIXTURE_INFO,
  FIXTURE_MIN_SIDE,
  PLAN_FLOORS,
  floorLinks,
  floorOf,
  floorView,
  heldFixtures,
  isStand,
  onFloor,
  planFloors,
  withFloor,
  PLAN_DOOR_MAX,
  PLAN_DOOR_MIN,
  PLAN_EXTENT,
  PLAN_MAX_FIXTURES,
  PLAN_MAX_WALKWAYS,
  PLAN_MIN_SIDE,
  wallSpan,
  type FixtureKind,
  type PlacedRoom,
  type PlanDoor,
  type PlanFixture,
  type PlanFloor,
  type PlanWall,
  type VenuePlan,
} from "./plan";
import type { VenueRoom } from "./rooms";
import { floorLayout } from "./plan-layout";
import { layoutStands, type StandSponsorRef } from "./stands";

export const PLAN_GRID = 0.5;
export const snap = (n: number) => r2(Math.round(n / PLAN_GRID) * PLAN_GRID);

/** Which area of the plan is meant: a room (by its room id), a walkway (by its id), or nothing. */
export type PlanTarget = { kind: "room"; id: string } | { kind: "corridor"; id: string } | { kind: "fixture"; id: string };

/** The edges a resize handle moves: any of west, north, east, south, or two for a corner. */
export interface Edges {
  w?: boolean;
  n?: boolean;
  e?: boolean;
  s?: boolean;
}

const isNS = (w: PlanWall) => w === "n" || w === "s";

/** The door kept on its wall: its width no longer than the wall, its centre so the whole door fits. */
export function fitDoor(rect: Rect, door: PlanDoor): PlanDoor {
  const [a0, a1] = wallSpan(rect, door.wall);
  const width = r2(clamp(door.width, PLAN_DOOR_MIN, Math.min(PLAN_DOOR_MAX, a1 - a0)));
  return { ...door, width, at: r2(clamp(door.at, a0 + width / 2, a1 - width / 2)) };
}

/** A rectangle kept inside the building limit, keeping its size. */
function keepInside(rect: Rect): Rect {
  const [x0, z0, x1, z1] = rect;
  const dx = clamp(x0, -PLAN_EXTENT, PLAN_EXTENT - (x1 - x0)) - x0;
  const dz = clamp(z0, -PLAN_EXTENT, PLAN_EXTENT - (z1 - z0)) - z0;
  return [r2(x0 + dx), r2(z0 + dz), r2(x1 + dx), r2(z1 + dz)];
}

/** A door moved with its room by (dx, dz). */
const shiftDoor = (door: PlanDoor, dx: number, dz: number): PlanDoor => ({ ...door, at: r2(door.at + (isNS(door.wall) ? dx : dz)) });

/** The rectangle of a room or walkway on the plan. */
export function rectOf(plan: VenuePlan, t: PlanTarget): Rect | null {
  if (t.kind === "room") return plan.rooms.find((p) => p.id === t.id)?.rect ?? null;
  if (t.kind === "fixture") return plan.fixtures.find((f) => f.id === t.id)?.rect ?? null;
  return plan.corridors.find((c) => c.id === t.id)?.rect ?? null;
}

/** The smallest side an edit leaves: a room or walkway 3 m, a fixture 0.3 m (a pillar can be thin). */
const minSide = (t: PlanTarget) => (t.kind === "fixture" ? FIXTURE_MIN_SIDE : PLAN_MIN_SIDE);

const contains = (outer: Rect, inner: Rect) => inner[0] >= outer[0] - 0.01 && inner[1] >= outer[1] - 0.01 && inner[2] <= outer[2] + 0.01 && inner[3] <= outer[3] + 0.01;

/** A rectangle slid (not resized) to lie inside `host`, when it fits; unchanged when it does not. */
function slideInto(rect: Rect, host: Rect): Rect {
  const w = rect[2] - rect[0];
  const d = rect[3] - rect[1];
  if (w > host[2] - host[0] + 0.01 || d > host[3] - host[1] + 0.01) return rect;
  const x0 = clamp(rect[0], host[0], host[2] - w);
  const z0 = clamp(rect[1], host[1], host[3] - d);
  return [r2(x0), r2(z0), r2(x0 + w), r2(z0 + d)];
}

/**
 * The fixtures standing in an area go with it (review MED, Oct 24): moved by
 * the same shift on a move, turned with it on a turn (`place`), and on a
 * resize slid back inside it where the new edges would leave them out.
 */
function carryFixtures(plan: VenuePlan, prev: Rect, place: (f: PlanFixture) => PlanFixture): PlanFixture[] {
  return plan.fixtures.map((f) => (contains(prev, f.rect) ? place(f) : f));
}

/** An area given a new rectangle. `moved` (a move, never a resize) carries the door along by the same shift. */
function withRect(plan: VenuePlan, t: PlanTarget, next: Rect, foyerId: string | null, moved = false): VenuePlan {
  const prev = rectOf(plan, t);
  if (!prev) return plan;
  if (t.kind === "fixture") return { ...plan, fixtures: plan.fixtures.map((f) => (f.id === t.id ? { ...f, rect: next } : f)) };
  const dx = next[0] - prev[0];
  const dz = next[1] - prev[1];
  const shift = (f: PlanFixture): PlanFixture => ({ ...f, rect: [r2(f.rect[0] + dx), r2(f.rect[1] + dz), r2(f.rect[2] + dx), r2(f.rect[3] + dz)] });
  const fixtures = carryFixtures(plan, prev, moved ? shift : (f) => ({ ...f, rect: slideInto(f.rect, next) }));
  if (t.kind === "corridor") return { ...plan, fixtures, corridors: plan.corridors.map((c) => (c.id === t.id ? { ...c, rect: next } : c)) };
  const carry = (door: PlanDoor) => fitDoor(next, moved ? shiftDoor(door, dx, dz) : door);
  return {
    ...plan,
    fixtures,
    rooms: plan.rooms.map((p) => (p.id === t.id ? { ...p, rect: next, door: carry(p.door) } : p)),
    entrance: t.id === foyerId ? carry(plan.entrance) : plan.entrance,
  };
}

/** Move an area so its north-west corner lands at (x0, z0), snapped; its door (and the foyer's entrance) go with it. */
export function moveTo(plan: VenuePlan, t: PlanTarget, x0: number, z0: number, foyerId: string | null): VenuePlan {
  return placeAt(plan, t, snap(x0), snap(z0), foyerId);
}

/** An area moved so its north-west corner is exactly (x0, z0), kept inside the building limit. */
function placeAt(plan: VenuePlan, t: PlanTarget, x0: number, z0: number, foyerId: string | null): VenuePlan {
  const r = rectOf(plan, t);
  if (!r) return plan;
  const next = keepInside([r2(x0), r2(z0), r2(x0 + r[2] - r[0]), r2(z0 + r[3] - r[1])]);
  return withRect(plan, t, next, foyerId, true);
}

/** Move an area by exactly (dx, dz), for the arrow keys: an area off the grid keeps its offset. */
export function nudge(plan: VenuePlan, t: PlanTarget, dx: number, dz: number, foyerId: string | null): VenuePlan {
  const r = rectOf(plan, t);
  return r ? placeAt(plan, t, r[0] + dx, r[1] + dz, foyerId) : plan;
}

// ── Snapping to other areas' edges (phase 2) ─────────────────────────────────

/** How close, in metres, an edge must come to another area's edge to line up with it. */
export const EDGE_SNAP = 0.75;

/** The lines an edge snapped to, to draw as guides: x values (north-south lines) and z values (east-west lines). */
export interface SnapGuides {
  x: number[];
  z: number[];
}

/** Every other area's edges, per axis. */
function edgesBesides(plan: VenuePlan, t: PlanTarget): { xs: number[]; zs: number[] } {
  // A fixture also lines up with other fixtures (a row of pillars); a room or walkway only with rooms and walkways.
  const rects = [
    ...plan.rooms.filter((p) => !(t.kind === "room" && p.id === t.id)).map((p) => p.rect),
    ...plan.corridors.filter((c) => !(t.kind === "corridor" && c.id === t.id)).map((c) => c.rect),
    ...(t.kind === "fixture" ? plan.fixtures.filter((f) => f.id !== t.id).map((f) => f.rect) : []),
  ];
  return { xs: rects.flatMap((r) => [r[0], r[2]]), zs: rects.flatMap((r) => [r[1], r[3]]) };
}

/** The smallest shift that puts one of `mine` on one of `theirs`, within EDGE_SNAP; null when none is that close. */
function closest(mine: number[], theirs: number[]): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null;
  for (const m of mine) {
    for (const o of theirs) {
      const shift = o - m;
      if (Math.abs(shift) <= EDGE_SNAP && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at: o };
    }
  }
  return best;
}

/**
 * Move as `moveTo` does, then line the area up with another area's edge when
 * one of its edges comes within EDGE_SNAP of it, so rooms sit flush even
 * where the grid would leave a gap (an area drawn off the grid by the
 * automatic layout, say). Returns the lines it lined up on.
 */
export function moveSnapped(plan: VenuePlan, t: PlanTarget, x0: number, z0: number, foyerId: string | null): { plan: VenuePlan; guides: SnapGuides } {
  const r = rectOf(plan, t);
  if (!r) return { plan, guides: { x: [], z: [] } };
  const w = r[2] - r[0];
  const d = r[3] - r[1];
  const { xs, zs } = edgesBesides(plan, t);
  let sx = snap(x0);
  let sz = snap(z0);
  const gx = closest([sx, sx + w], xs);
  const gz = closest([sz, sz + d], zs);
  if (gx) sx += gx.shift;
  if (gz) sz += gz.shift;
  const next = placeAt(plan, t, sx, sz, foyerId);
  // A guide only where an edge really sits on the line (the building limit can push the area off it).
  const at = rectOf(next, t) ?? r;
  const on = (v: number, a: number, b: number) => r2(v) === a || r2(v) === b;
  return { plan: next, guides: { x: gx && on(gx.at, at[0], at[2]) ? [gx.at] : [], z: gz && on(gz.at, at[1], at[3]) ? [gz.at] : [] } };
}

/** Resize as `resizeTo` does, each dragged edge lining up with another area's edge within EDGE_SNAP. */
export function resizeSnapped(plan: VenuePlan, t: PlanTarget, edges: Edges, x: number, z: number, foyerId: string | null): { plan: VenuePlan; guides: SnapGuides } {
  const { xs, zs } = edgesBesides(plan, t);
  const gx = edges.w || edges.e ? closest([snap(x)], xs) : null;
  const gz = edges.n || edges.s ? closest([snap(z)], zs) : null;
  const next = resizeExact(plan, t, edges, gx ? gx.at : snap(x), gz ? gz.at : snap(z), foyerId);
  const r = rectOf(next, t);
  // A guide only where the edge really landed on the line (the minimum size can hold it back).
  const landedX = gx && r && (r[0] === r2(gx.at) || r[2] === r2(gx.at));
  const landedZ = gz && r && (r[1] === r2(gz.at) || r[3] === r2(gz.at));
  return { plan: next, guides: { x: landedX ? [gx.at] : [], z: landedZ ? [gz.at] : [] } };
}

/** Drag the chosen edges of an area to the point (x, z), snapped, never smaller than the minimum side. */
export function resizeTo(plan: VenuePlan, t: PlanTarget, edges: Edges, x: number, z: number, foyerId: string | null): VenuePlan {
  return resizeExact(plan, t, edges, snap(x), snap(z), foyerId);
}

/** The chosen edges moved to exactly x and z, never smaller than the minimum side or outside the building limit. */
function resizeExact(plan: VenuePlan, t: PlanTarget, edges: Edges, x: number, z: number, foyerId: string | null): VenuePlan {
  const r = rectOf(plan, t);
  if (!r) return plan;
  let [x0, z0, x1, z1] = r;
  const sx = clamp(x, -PLAN_EXTENT, PLAN_EXTENT);
  const sz = clamp(z, -PLAN_EXTENT, PLAN_EXTENT);
  const min = minSide(t);
  if (edges.w) x0 = Math.min(sx, x1 - min);
  if (edges.e) x1 = Math.max(sx, x0 + min);
  if (edges.n) z0 = Math.min(sz, z1 - min);
  if (edges.s) z1 = Math.max(sz, z0 + min);
  return withRect(plan, t, [r2(x0), r2(z0), r2(x1), r2(z1)], foyerId);
}

/** Set an area's size directly (the side panel): width east-west, depth north-south, from its north-west corner. */
export function setSize(plan: VenuePlan, t: PlanTarget, width: number, depth: number, foyerId: string | null): VenuePlan {
  const r = rectOf(plan, t);
  if (!r) return plan;
  // A fixture is sized to the 0.1 m (a 0.8 m pillar); rooms and walkways to the grid.
  const fine = t.kind === "fixture";
  const w = Math.max(minSide(t), fine ? r2(width) : snap(width));
  const d = Math.max(minSide(t), fine ? r2(depth) : snap(depth));
  return withRect(plan, t, keepInside([r[0], r[1], r2(r[0] + w), r2(r[1] + d)]), foyerId);
}

const TURN: Record<PlanWall, PlanWall> = { n: "e", e: "s", s: "w", w: "n" };

/** Towards zero, to the grid: odd, so a turn's shift and the next turn's cancel exactly. */
const snapIn = (n: number) => r2(Math.trunc(n / PLAN_GRID) * PLAN_GRID);

/**
 * A door turned a quarter clockwise with its room, from `prev` to `next`. Kept
 * by its distance along its wall, not by coordinates: the north wall's west
 * end becomes the east wall's north end, and so on round, so four turns put it
 * back exactly.
 */
function turnDoor(door: PlanDoor, prev: Rect, next: Rect): PlanDoor {
  const along = isNS(door.wall) ? door.at - prev[0] : door.at - prev[1];
  const at = door.wall === "n" || door.wall === "s" ? next[1] + along : next[2] - along;
  return { ...door, wall: TURN[door.wall], at: r2(at) };
}

/**
 * Turn a room or walkway a quarter clockwise about its centre (decision F1:
 * 90 degree steps). Width and depth swap; the door turns to the next wall
 * round; the foyer's entrance turns with it. The corners stay on the grid:
 * when the centre would put them a quarter metre off, the room shifts that
 * quarter towards its old corner, and the next turn shifts it back, so four
 * turns are exactly where it started.
 */
export function turn(plan: VenuePlan, t: PlanTarget, foyerId: string | null): VenuePlan {
  const r = rectOf(plan, t);
  if (!r) return plan;
  const w = r[2] - r[0];
  const d = r[3] - r[1];
  if (t.kind === "fixture") return turnFixture(plan, t.id);
  const x0 = r2(r[0] + snapIn((w - d) / 2));
  const z0 = r2(r[1] + snapIn((d - w) / 2));
  const next = keepInside([x0, z0, r2(x0 + d), r2(z0 + w)]);
  // The fixtures inside turn with the area: about its centre, then by the same grid shift the area took.
  const cx = (r[0] + r[2]) / 2;
  const cz = (r[1] + r[3]) / 2;
  const ox = next[0] - (cx - d / 2);
  const oz = next[1] - (cz - w / 2);
  const spin = (f: PlanFixture): PlanFixture => {
    const [fx0, fz0, fx1, fz1] = f.rect;
    const rect: Rect = [r2(cx - (fz1 - cz) + ox), r2(cz + (fx0 - cx) + oz), r2(cx - (fz0 - cz) + ox), r2(cz + (fx1 - cx) + oz)];
    return { ...f, rect: slideInto(rect, next), dir: TURN[f.dir] };
  };
  const fixtures = carryFixtures(plan, r, spin);
  if (t.kind === "corridor") return { ...plan, fixtures, corridors: plan.corridors.map((c) => (c.id === t.id ? { ...c, rect: next } : c)) };
  const fit = (door: PlanDoor) => fitDoor(next, turnDoor(door, r, next));
  return {
    ...plan,
    fixtures,
    rooms: plan.rooms.map((p) => (p.id === t.id ? { ...p, rect: next, door: fit(p.door) } : p)),
    entrance: t.id === foyerId ? fit(plan.entrance) : plan.entrance,
  };
}

/**
 * Turn a fixture a quarter clockwise about its exact centre (a 0.4 m exit sign
 * is not on the 0.5 m grid), then slide it back inside the room or walkway it
 * stood in, so turning one against a wall keeps it in its room (review LOW).
 */
function turnFixture(plan: VenuePlan, id: string): VenuePlan {
  const f = plan.fixtures.find((x) => x.id === id);
  if (!f) return plan;
  const host = [...plan.rooms.map((p) => p.rect), ...plan.corridors.map((c) => c.rect)].find((a) => contains(a, f.rect));
  const [x0, z0, x1, z1] = f.rect;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hw = (z1 - z0) / 2;
  const hd = (x1 - x0) / 2;
  const spun: Rect = [r2(cx - hw), r2(cz - hd), r2(cx + hw), r2(cz + hd)];
  const rect = host ? slideInto(spun, host) : spun;
  return { ...plan, fixtures: plan.fixtures.map((x) => (x.id === id ? { ...x, rect, dir: TURN[x.dir] } : x)) };
}

/** Put a room's door (or, with `entrance`, the foyer's entrance) on a wall, at a point along it. */
export function setDoor(plan: VenuePlan, roomId: string, patch: Partial<PlanDoor>, entrance = false): VenuePlan {
  const p = plan.rooms.find((r) => r.id === roomId);
  if (!p) return plan;
  const cur = entrance ? plan.entrance : p.door;
  const wallChanged = patch.wall !== undefined && patch.wall !== cur.wall;
  // A door moved to another wall starts at that wall's middle.
  const [a0, a1] = wallSpan(p.rect, patch.wall ?? cur.wall);
  const next = fitDoor(p.rect, { ...cur, ...patch, ...(wallChanged && patch.at === undefined && { at: (a0 + a1) / 2 }) });
  if (entrance) return { ...plan, entrance: next };
  return { ...plan, rooms: plan.rooms.map((r) => (r.id === roomId ? { ...r, door: next } : r)) };
}

/** A walkway drawn from one corner to the other, snapped and at least the minimum side; null when the drag was too small to mean one. */
export function walkwayRect(ax: number, az: number, bx: number, bz: number): Rect | null {
  const x0 = snap(Math.min(ax, bx));
  const z0 = snap(Math.min(az, bz));
  const x1 = snap(Math.max(ax, bx));
  const z1 = snap(Math.max(az, bz));
  if (x1 - x0 < 1 && z1 - z0 < 1) return null;
  return keepInside([x0, z0, Math.max(x1, r2(x0 + PLAN_MIN_SIDE)), Math.max(z1, r2(z0 + PLAN_MIN_SIDE))]);
}

/** Room for one more walkway (a plan holds at most PLAN_MAX_WALKWAYS). */
export const canAddWalkway = (plan: VenuePlan) => plan.corridors.length < PLAN_MAX_WALKWAYS;

/** Add a walkway with the next free id and name ("Walkway 2"); null when the plan already holds the most it can. */
export function addWalkway(plan: VenuePlan, rect: Rect): { plan: VenuePlan; id: string } | null {
  if (!canAddWalkway(plan)) return null;
  const ids = new Set([...plan.corridors.map((c) => c.id), ...plan.rooms.map((p) => p.id), ...(plan.otherIds ?? [])]);
  let n = plan.corridors.length + 1;
  while (ids.has(`walkway-${n}`)) n++;
  const id = `walkway-${n}`;
  return { plan: { ...plan, corridors: [...plan.corridors, { id, name: `Walkway ${n}`, rect }] }, id };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

export const canAddFixture = (plan: VenuePlan) => plan.fixtures.length < PLAN_MAX_FIXTURES;

/**
 * Add a fixture at its usual size, a quarter of the way into `inside` (the selected room or
 * walkway, else the foyer, else the first area), facing south, with the next
 * free id ("pillar-2"). Null when the plan holds the most it can.
 */
export function addFixture(plan: VenuePlan, kind: FixtureKind, inside: Rect | null): { plan: VenuePlan; id: string } | null {
  if (!canAddFixture(plan)) return null;
  const host = inside ?? plan.rooms[0]?.rect ?? plan.corridors[0]?.rect;
  if (!host) return null;
  const [w0, d0] = FIXTURE_INFO[kind].size;
  // Never bigger than the area it goes in.
  const w = Math.min(w0, host[2] - host[0]);
  const d = Math.min(d0, host[3] - host[1]);
  // A quarter of the way in from the north-west corner, not the middle, where the room's name is written,
  // then the first free spot along and down from there, so a new fixture never lands on one already there.
  const [x0, z0] = freeSpot(plan, host, w, d);
  const ids = new Set([...plan.fixtures.map((f) => f.id), ...plan.rooms.map((p) => p.id), ...plan.corridors.map((c) => c.id), ...(plan.otherIds ?? [])]);
  let n = plan.fixtures.filter((f) => f.kind === kind).length + 1;
  while (ids.has(`${kind}-${n}`)) n++;
  const id = `${kind}-${n}`;
  const fixture: PlanFixture = { id, kind, name: "", rect: [x0, z0, r2(x0 + w), r2(z0 + d)], dir: "s" };
  return { plan: { ...plan, fixtures: [...plan.fixtures, fixture] }, id };
}

/** The first place in `host`, scanning in 1 m steps from a quarter of the way in, where a w x d fixture overlaps none already there. */
function freeSpot(plan: VenuePlan, host: Rect, w: number, d: number): [number, number] {
  const sx = Math.min(host[0] + (host[2] - host[0]) / 4, host[2] - w);
  const sz = Math.min(host[1] + (host[3] - host[1]) / 4, host[3] - d);
  const others = plan.fixtures.map((f) => f.rect);
  const clear = (x: number, z: number) => !others.some((o) => x < o[2] + 0.2 && o[0] < x + w + 0.2 && z < o[3] + 0.2 && o[1] < z + d + 0.2);
  for (let z = sz; z <= host[3] - d + 0.01; z += 1) {
    for (let x = sx; x <= host[2] - w + 0.01; x += 1) if (clear(x, z)) return [r2(x), r2(z)];
    for (let x = host[0]; x < sx; x += 1) if (clear(x, z)) return [r2(x), r2(z)];
  }
  // A room full of fixtures: the usual spot, flagged as overlapping until moved.
  return [r2(sx), r2(sz)];
}

export function removeFixture(plan: VenuePlan, id: string): VenuePlan {
  return { ...plan, fixtures: plan.fixtures.filter((f) => f.id !== id) };
}

/**
 * A fixture's name (shown on its sign; blank uses the kind's own), the way it faces, a stand's number or
 * sponsor, the team's note, or whether exhibitors see it. A blank note is no note.
 */
export function setFixture(plan: VenuePlan, id: string, patch: Partial<Pick<PlanFixture, "name" | "dir" | "number" | "sponsorId" | "note" | "internal">>): VenuePlan {
  return {
    ...plan,
    fixtures: plan.fixtures.map((f) => {
      if (f.id !== id) return f;
      const next = { ...f, ...patch };
      if (patch.note !== undefined && !patch.note) delete next.note;
      return next;
    }),
  };
}

// ── Stands (section 10) ──────────────────────────────────────────────────────

/** Every stand number on the plan, both floors (a floor's view carries the other floor's in `otherNumbers`). */
const standNumbers = (plan: VenuePlan) => [...plan.fixtures.flatMap((f) => (f.number ? [f.number] : [])), ...(plan.otherNumbers ?? [])];

/**
 * The number a new stand takes: one more than the highest plain number on the plan, written as wide as the
 * widest plain number already there, so a plan numbered 01 to 13 goes on with 14, and "01" stays "01".
 */
export function nextStandNumber(plan: VenuePlan): string {
  const plain = standNumbers(plan).filter((n) => /^\d+$/.test(n));
  const next = plain.length ? Math.max(...plain.map(Number)) + 1 : 1;
  const width = Math.max(1, ...plain.map((n) => n.length));
  return String(next).padStart(width, "0");
}

/** A fixture id not yet used on the plan or the other floor: `${kind}-${n}`. */
function freeId(plan: VenuePlan, kind: FixtureKind): string {
  const ids = new Set([...plan.fixtures.map((f) => f.id), ...plan.rooms.map((p) => p.id), ...plan.corridors.map((c) => c.id), ...(plan.otherIds ?? [])]);
  let n = plan.fixtures.filter((f) => f.kind === kind).length + 1;
  while (ids.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/**
 * Add a stand or table, width by depth, in `inside` (as `addFixture` places any fixture), open to the south,
 * with the next free number and no sponsor yet. Null when the plan holds the most fixtures it can.
 */
export function addStand(plan: VenuePlan, kind: "stand" | "table", size: [number, number], inside: Rect | null): { plan: VenuePlan; id: string } | null {
  if (!canAddFixture(plan)) return null;
  const host = inside ?? plan.rooms[0]?.rect ?? plan.corridors[0]?.rect;
  if (!host) return null;
  const w = Math.min(size[0], host[2] - host[0]);
  const d = Math.min(size[1], host[3] - host[1]);
  const [x0, z0] = freeSpot(plan, host, w, d);
  const id = freeId(plan, kind);
  const stand: PlanFixture = { id, kind, name: "", rect: [x0, z0, r2(x0 + w), r2(z0 + d)], dir: "s", number: nextStandNumber(plan), sponsorId: null };
  return { plan: { ...plan, fixtures: [...plan.fixtures, stand], standsPlaced: true }, id };
}

/** The way a layout yaw looks, as a plan wall: (sin, cos) of yaw is the direction, +z south. */
function wallOfYaw(yaw: number): PlanWall {
  const dx = Math.round(Math.sin(yaw));
  const dz = Math.round(Math.cos(yaw));
  if (dz > 0) return "s";
  if (dz < 0) return "n";
  return dx > 0 ? "e" : "w";
}

/**
 * Place the stands yourself, starting from exactly what the venue shows now: every stand the exhibition rooms
 * make on their own becomes a stand on the plan, at its place and size, numbered as it was (on through the
 * floors) and holding the sponsor it held by tier order (`ordered`). From then on the team moves, sizes,
 * numbers and gives out each stand. The whole plan, both floors.
 */
export function placeStandsYourself(plan: VenuePlan, rooms: VenueRoom[], ordered: StandSponsorRef[]): VenuePlan {
  if (plan.standsPlaced) return plan;
  let next: VenuePlan = { ...plan, fixtures: [...plan.fixtures] };
  let n = 0;
  for (const floor of PLAN_FLOORS) {
    const view = floorView(plan, floor);
    if (!view.rooms.length) continue;
    for (const s of layoutStands(floorLayout(rooms, view, { eventName: "" }).layout)) {
      if (s.key || "r" in s.foot || !canAddFixture(next)) continue;
      n += 1;
      const id = freeId(next, "stand");
      const stand: PlanFixture = { id, kind: "stand", name: "", rect: [s.foot.x0, s.foot.z0, s.foot.x1, s.foot.z1], dir: wallOfYaw(s.face), number: String(n), sponsorId: ordered[n - 1]?.id ?? null };
      next = { ...next, fixtures: [...next.fixtures, onFloor(stand, floor)] };
    }
  }
  return { ...next, standsPlaced: true };
}

/** Back to the exhibition rooms' own stands, each going to the nth sponsor by tier: the placed stands go. */
export function automaticStands(plan: VenuePlan): VenuePlan {
  const rest = { ...plan, fixtures: plan.fixtures.filter((f) => !isStand(f)) };
  delete rest.standsPlaced;
  return rest;
}

/**
 * Number every stand and table again in reading order: the ground floor first, then row by row from the
 * north (stands whose middles are within 1.5 m north to south count as one row), west to east along each.
 * Two digits once there are ten or more ("01" to "13"), as the venues' own drawings number them.
 */
export function renumberStands(plan: VenuePlan): VenuePlan {
  const stands = plan.fixtures.filter(isStand);
  const mid = (f: PlanFixture) => [(f.rect[0] + f.rect[2]) / 2, (f.rect[1] + f.rect[3]) / 2] as const;
  const byNorth = [...stands].sort((a, b) => PLAN_FLOORS.indexOf(floorOf(a)) - PLAN_FLOORS.indexOf(floorOf(b)) || mid(a)[1] - mid(b)[1]);
  const rows: PlanFixture[][] = [];
  for (const f of byNorth) {
    const row = rows[rows.length - 1];
    if (row && floorOf(row[0]) === floorOf(f) && mid(f)[1] - mid(row[0])[1] <= 1.5) row.push(f);
    else rows.push([f]);
  }
  const order = rows.flatMap((row) => row.sort((a, b) => mid(a)[0] - mid(b)[0]));
  const width = order.length >= 10 ? String(order.length).length : 1;
  const numbers = new Map(order.map((f, i) => [f.id, String(i + 1).padStart(width, "0")]));
  return { ...plan, fixtures: plan.fixtures.map((f) => (numbers.has(f.id) ? { ...f, number: numbers.get(f.id) } : f)) };
}

export function removeWalkway(plan: VenuePlan, id: string): VenuePlan {
  return { ...plan, corridors: plan.corridors.filter((c) => c.id !== id) };
}

export function renameWalkway(plan: VenuePlan, id: string, name: string): VenuePlan {
  return { ...plan, corridors: plan.corridors.map((c) => (c.id === id ? { ...c, name } : c)) };
}

const touches = (a: Rect, b: Rect) => a[0] <= b[2] + 0.01 && b[0] <= a[2] + 0.01 && a[1] <= b[3] + 0.01 && b[1] <= a[3] + 0.01;

/**
 * A free spot w x d beside the building, to its east: below anything already
 * waiting there, so two things put beside the plan never land on each other.
 * "Waiting" is an area touching nothing else (put there by this and not yet
 * dragged into the building); the building's edge is measured without them.
 */
export function spotBeside(plan: VenuePlan, w: number, d: number): Rect {
  const all = [...plan.rooms.map((p) => p.rect), ...plan.corridors.map((c) => c.rect)];
  const alone = (r: Rect) => !all.some((o) => o !== r && touches(r, o));
  const building = all.filter((r) => !alone(r));
  const base = building.length ? building : all;
  const east = base.length ? Math.max(...base.map((r) => r[2])) : 0;
  const north = base.length ? Math.min(...base.map((r) => r[1])) : 0;
  const waiting = all.filter((r) => alone(r) && r[0] >= east - 0.01);
  const z0 = snap(waiting.length ? Math.max(...waiting.map((r) => r[3])) + 2 : north);
  const x0 = snap(east + 6);
  return keepInside([x0, z0, r2(x0 + snap(w)), r2(z0 + snap(d))]);
}

/**
 * Put a room that is on the list but not yet on the plan beside the building,
 * at the size the automatic layout gives it, door on its west wall. The
 * organiser then drags it where it belongs (section 3.4).
 */
export function placeRoom(plan: VenuePlan, rooms: VenueRoom[], id: string): VenuePlan {
  if (plan.rooms.some((p) => p.id === id) || !rooms.some((r) => r.id === id)) return plan;
  const auto = generateLayout(rooms, { eventName: "" }).zones.find((z) => z.id === id);
  const rect = spotBeside(plan, auto ? auto.rect[2] - auto.rect[0] : 12, auto ? auto.rect[3] - auto.rect[1] : 12);
  const door = fitDoor(rect, { wall: "w", at: (rect[1] + rect[3]) / 2, width: 2.6 });
  const placed: PlacedRoom = { id, rect, door };
  return { ...plan, rooms: [...plan.rooms, placed] };
}

/**
 * Move a room or walkway, with the fixtures standing in it, to the other floor: to the same place, so it
 * stands over where it was, or beside that floor's building when something there already holds that place.
 * The foyer stays on the ground floor (it is the way in).
 */
export function toFloor(plan: VenuePlan, t: PlanTarget, floor: PlanFloor, foyerId: string | null): VenuePlan {
  if (t.kind === "fixture" || t.id === foyerId) return plan;
  const area = t.kind === "room" ? plan.rooms.find((p) => p.id === t.id) : plan.corridors.find((c) => c.id === t.id);
  if (!area || floorOf(area) === floor) return plan;
  const from = floorOf(area);
  const rect = area.rect;
  const moved: VenuePlan = {
    ...plan,
    rooms: plan.rooms.map((p) => (t.kind === "room" && p.id === t.id ? onFloor(p, floor) : p)),
    corridors: plan.corridors.map((c) => (t.kind === "corridor" && c.id === t.id ? onFloor(c, floor) : c)),
    fixtures: plan.fixtures.map((f) => (floorOf(f) === from && contains(rect, f.rect) ? onFloor(f, floor) : f)),
  };
  const there = floorView(moved, floor);
  const others = [...there.rooms.filter((p) => p.id !== t.id), ...there.corridors.filter((c) => c.id !== t.id)].map((a) => a.rect);
  const clash = (r: Rect) => others.some((o) => Math.min(r[2], o[2]) - Math.max(r[0], o[0]) > 0.01 && Math.min(r[3], o[3]) - Math.max(r[1], o[1]) > 0.01);
  if (!clash(rect)) return moved;
  const spot = spotBeside({ ...there, rooms: there.rooms.filter((p) => p.id !== t.id), corridors: there.corridors.filter((c) => c.id !== t.id) }, rect[2] - rect[0], rect[3] - rect[1]);
  // Only the fixtures that came up with this area go beside the building with it: the ones already
  // standing on that floor in the same place (the room it clashed with, its stairs) stay where they are.
  const carried = new Set(plan.fixtures.filter((f) => floorOf(f) === from && contains(rect, f.rect)).map((f) => f.id));
  const placed = placeAt({ ...there, fixtures: there.fixtures.filter((f) => carried.has(f.id)) }, t, spot[0], spot[1], foyerId);
  return withFloor(moved, floor, { ...placed, fixtures: [...there.fixtures.filter((f) => !carried.has(f.id)), ...placed.fixtures] });
}

// ── Stairs and lifts across floors ──────────────────────────────────────────

/** Stairs and lifts join the floors when they stand in the same place on both. */
const JOINS: ReadonlySet<FixtureKind> = new Set(["stairs", "lift"]);

/** For a stair or lift with nothing of its kind in the same place on the other floor: that floor; else null. */
export function missingPartner(plan: VenuePlan, id: string): PlanFloor | null {
  const f = plan.fixtures.find((x) => x.id === id);
  if (!f || !JOINS.has(f.kind) || !planFloors(plan).includes("level-1")) return null;
  const other: PlanFloor = floorOf(f) === "ground" ? "level-1" : "ground";
  const stacked = plan.fixtures.some((g) => floorOf(g) === other && g.kind === f.kind && Math.min(g.rect[2], f.rect[2]) - Math.max(g.rect[0], f.rect[0]) > 0.01 && Math.min(g.rect[3], f.rect[3]) - Math.max(g.rect[1], f.rect[1]) > 0.01);
  return stacked ? null : other;
}

/**
 * Put the matching stair or lift on the other floor, in exactly the same place, which is what joins them
 * (owner, Oct 26: placing them by hand to line up was the hard part). Null when there is nothing to match,
 * or no room or walkway on that floor holds that place.
 */
export function addPartner(plan: VenuePlan, id: string): { plan: VenuePlan; id: string } | null {
  const other = missingPartner(plan, id);
  const f = plan.fixtures.find((x) => x.id === id);
  if (!other || !f || !canAddFixture(plan)) return null;
  const there = floorView(plan, other);
  if (![...there.rooms, ...there.corridors].some((a) => contains(a.rect, f.rect))) return null;
  const ids = new Set([...plan.fixtures, ...plan.rooms, ...plan.corridors].map((a) => a.id));
  let n = plan.fixtures.filter((x) => x.kind === f.kind).length + 1;
  while (ids.has(`${f.kind}-${n}`)) n++;
  const added = onFloor({ ...f, id: `${f.kind}-${n}` }, other);
  return { plan: { ...plan, fixtures: [...plan.fixtures, added] }, id: added.id };
}

const samePlace = (a: PlanFixture, b: PlanFixture) => a.rect.every((v, i) => v === b.rect[i]);

/**
 * Joined stairs and lifts stay joined (owner, Oct 27): when an edit moves, resizes or turns one end, the
 * other end on the other floor takes the same place, so long as a room or walkway there still holds it.
 * Where none does, it stays put and the plan says the two no longer line up. Each end is compared with
 * `before`, the plan the edit started from, never with an end this has just moved. A turn passes on;
 * otherwise each end keeps its own way of facing, since a lift can open a different way on each floor.
 */
export function keepPairs(before: VenuePlan, after: VenuePlan): VenuePlan {
  const links = floorLinks(before);
  if (!links.length) return after;
  const follow = new Map<string, PlanFixture>();
  for (const { lower, upper } of links) {
    const lo = after.fixtures.find((f) => f.id === lower.id);
    const up = after.fixtures.find((f) => f.id === upper.id);
    if (!lo || !up) continue;
    const loChanged = !samePlace(lo, lower) || lo.dir !== lower.dir;
    // Both ends changed in the one edit, or neither did: nothing to follow.
    if (loChanged === (!samePlace(up, upper) || up.dir !== upper.dir)) continue;
    const [lead, was, follower] = loChanged ? [lo, lower, up] : [up, upper, lo];
    const there = floorView(after, floorOf(follower));
    if (![...there.rooms, ...there.corridors].some((a) => contains(a.rect, lead.rect))) continue;
    follow.set(follower.id, { ...follower, rect: lead.rect, dir: lead.dir === was.dir ? follower.dir : lead.dir });
  }
  if (!follow.size) return after;
  return { ...after, fixtures: after.fixtures.map((f) => follow.get(f.id) ?? f) };
}

/** Remove a fixture, and the other end of a joined stair or lift with it: half a staircase is no use (review LOW, Oct 27). */
export function removeJoined(plan: VenuePlan, id: string): VenuePlan {
  const link = floorLinks(plan).find((l) => l.lower.id === id || l.upper.id === id);
  const gone = new Set([id, ...(link ? [link.lower.id, link.upper.id] : [])]);
  return { ...plan, fixtures: plan.fixtures.filter((f) => !gone.has(f.id)) };
}

/** The floor an area or fixture is on, or null when the plan does not hold it. */
export function targetFloor(plan: VenuePlan, t: PlanTarget): PlanFloor | null {
  const list = { room: plan.rooms, corridor: plan.corridors, fixture: plan.fixtures }[t.kind];
  const found = list.find((a) => a.id === t.id);
  return found ? floorOf(found) : null;
}

/** Rooms on the list that the plan does not place yet. */
export const unplacedRooms = (plan: VenuePlan, rooms: VenueRoom[]) => rooms.filter((r) => !plan.rooms.some((p) => p.id === r.id));

/** A plan with only the rooms still on the list (a room removed from the list since drops out). */
export function keepListedRooms(plan: VenuePlan, rooms: VenueRoom[]): VenuePlan {
  const kept = { ...plan, rooms: plan.rooms.filter((p) => rooms.some((r) => r.id === p.id)) };
  // The fixtures that stood in a dropped room go with it.
  return { ...kept, fixtures: heldFixtures(kept) };
}

/**
 * Rooms drawn too small for the people they hold (decision F2: a warning, not
 * a refusal). Measured the way the furnishers lay a room out: across from its
 * door, and from the door to the far wall.
 */
export function tooSmall(plan: VenuePlan, rooms: VenueRoom[]): string[] {
  const out: string[] = [];
  for (const p of plan.rooms) {
    const room = rooms.find((r) => r.id === p.id);
    if (!room) continue;
    const across = isNS(p.door.wall) ? p.rect[2] - p.rect[0] : p.rect[3] - p.rect[1];
    const deep = isNS(p.door.wall) ? p.rect[3] - p.rect[1] : p.rect[2] - p.rect[0];
    if (!fits(room, across, deep)) out.push(`${room.name} is drawn too small for ${room.capacity.toLocaleString("en-GB")} people; the venue will show fewer seats or stands`);
  }
  return out;
}

/** Areas that overlap another, by id, to tint on the canvas. */
export function overlapping(plan: VenuePlan): Set<string> {
  const areas = [...plan.rooms.map((p) => ({ id: p.id, r: p.rect })), ...plan.corridors.map((c) => ({ id: c.id, r: c.rect }))];
  const hit = new Set<string>();
  const markOverlaps = (list: { id: string; r: Rect }[]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].r;
        const b = list[j].r;
        const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const oz = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (ox > 0.01 && oz > 0.01) hit.add(list[i].id).add(list[j].id);
      }
    }
  };
  markOverlaps(areas);
  // Fixtures stand inside areas, so they are wrong only on each other, or when no one area holds them.
  markOverlaps(plan.fixtures.map((f) => ({ id: f.id, r: f.rect })));
  const holds = (r: Rect, o: Rect) => r[0] >= o[0] - 0.01 && r[1] >= o[1] - 0.01 && r[2] <= o[2] + 0.01 && r[3] <= o[3] + 0.01;
  for (const f of plan.fixtures) if (!areas.some((a) => holds(f.rect, a.r))) hit.add(f.id);
  return hit;
}
