/**
 * The venue generator (docs/EVENT_BLUEPRINT_PLAN.md, D10, phase 6 step 2):
 * an event's room list in, the walkable venue's layout out. Pure and
 * deterministic: the same rooms always give the same building, so the layout
 * is computed when needed and never stored.
 *
 * The plan is fixed (D10) and adapts to the rooms:
 *
 *            north
 *     ┌──────────────────────┐
 *     │       plenary        │   at the end of the corridor
 *     ├──────┬──────┬────────┤ z = -L
 *     │ hall │      │ exhib. │
 *     │ hall │ cor- │        │   halls, workshops, posters to the west;
 *     │ work │ ridor│ lounge │   exhibition and lounge to the east
 *     ├──────┴──────┴────────┤ z = 0
 *     │        foyer         │   the entrance, registration
 *     └──────────────────────┘ z = Df
 *            south (entrance)
 *
 * Units are metres; +x is east and -z is north, as in the venue's own code
 * (vendor/ehc-venue/src/world.js). A seat or person facing `yaw` looks along
 * (sin yaw, cos yaw). Every room is furnished in its own frame: u runs across
 * the room, v from the door (0) to the far wall (D), so one furnisher serves a
 * room on either side.
 */
import type { RoomKind, VenueRoom } from "./rooms";

export type Rect = [number, number, number, number];
export type ZoneKind = RoomKind | "corridor";

export interface LayoutZone {
  id: string;
  name: string;
  sub: string;
  kind: ZoneKind;
  rect: Rect;
  ceil: number;
  spawn: [number, number, number];
  floor: "marble" | "carpetG" | "carpet" | "wood";
  tint?: [number, number, number];
  capacity: number;
}

export interface WallOpening {
  a: number;
  b: number;
  y1?: number;
  glass?: boolean;
}

/** A wall along x at z = k (axis "x") or along z at x = k (axis "z"), from a0 to a1, with openings. */
export interface LayoutWall {
  axis: "x" | "z";
  k: number;
  a0: number;
  a1: number;
  h: number;
  opens: WallOpening[];
}

export interface LayoutDoor {
  x: number;
  z: number;
  width: number;
  /** The wall it is in: "x" walls run east-west. */
  axis: "x" | "z";
  between: [string, string];
}

export type Footprint = { x0: number; z0: number; x1: number; z1: number } | { cx: number; cz: number; r: number };

interface ItemBase {
  zone: string;
  /** People cannot walk through it. */
  solid: boolean;
  foot: Footprint;
}

export type LayoutItem = ItemBase &
  (
    | { t: "stage"; h: number }
    | { t: "screen"; id: string; x: number; y: number; z: number; w: number; hgt: number; yaw: number; kicker: string; title: string; sub: string }
    | { t: "row"; p0: [number, number]; p1: [number, number]; n: number; yaw: number }
    | { t: "lectern" }
    | { t: "round"; cx: number; cz: number; chairs: number }
    | { t: "stand"; face: number; label: string; tier: number; /** 1-based; the venue gives stand n to the nth sponsor by tier. */ n: number }
    | { t: "poster"; yaw: number }
    | { t: "sofa"; yaw: number }
    | { t: "bar"; yaw: number }
    | { t: "highTable"; cx: number; cz: number }
    | { t: "desk"; yaw: number; title: string; sub: string }
    | { t: "directory"; yaw: number }
    | { t: "plant"; cx: number; cz: number; s: number }
    | { t: "sign"; x: number; y: number; z: number; w: number; hgt: number; yaw: number; kicker: string; title: string; sub: string }
  );

export interface LayoutPerson {
  x: number;
  z: number;
  y?: number;
  yaw: number;
  pose: "stand" | "present" | "talk";
  role: "staff" | "speaker" | "barista" | "exhibitor" | "guest" | "tech";
}

export interface LayoutHotspot {
  id: string;
  x: number;
  z: number;
  r: number;
  prompt: string;
  title: string;
  body: string;
  kind: "info" | "screen" | "stand";
}

export interface VenueLayout {
  v: 1;
  bounds: Rect;
  zones: LayoutZone[];
  walls: LayoutWall[];
  doors: LayoutDoor[];
  items: LayoutItem[];
  people: LayoutPerson[];
  hotspots: LayoutHotspot[];
  /** Closed walking loops for the moving crowd. */
  routes: [number, number][][];
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** Floor per person, and the floor the room needs whatever its size (stage, aisles, bars). */
const SPACE: Record<RoomKind, { perPerson: number; base: number; min: number }> = {
  foyer: { perPerson: 0.9, base: 0, min: 320 },
  plenary: { perPerson: 1.05, base: 140, min: 320 },
  hall: { perPerson: 1.1, base: 60, min: 150 },
  workshop: { perPerson: 2.6, base: 30, min: 110 },
  posters: { perPerson: 1.6, base: 40, min: 150 },
  exhibition: { perPerson: 2.0, base: 120, min: 420 },
  lounge: { perPerson: 2.0, base: 50, min: 160 },
};

const CEIL: Record<ZoneKind, number> = { foyer: 7, plenary: 9, hall: 6, workshop: 5.5, posters: 5.5, exhibition: 7, lounge: 5.5, corridor: 5 };
const FLOOR: Record<ZoneKind, LayoutZone["floor"]> = { foyer: "marble", plenary: "carpetG", hall: "carpet", workshop: "carpet", posters: "wood", exhibition: "carpet", lounge: "wood", corridor: "marble" };
const SUB: Record<ZoneKind, string> = {
  foyer: "Registration · Welcome",
  plenary: "Main stage",
  hall: "Parallel sessions",
  workshop: "Hands-on sessions",
  posters: "Abstracts · E-posters",
  exhibition: "Partners · Exhibitors",
  lounge: "Coffee · Meetings",
  corridor: "To every room",
};
const HALL_TINTS: [number, number, number][] = [[0.3, 0.5, 0.52], [0.38, 0.4, 0.64], [0.56, 0.34, 0.48], [0.4, 0.52, 0.4], [0.6, 0.48, 0.34], [0.36, 0.44, 0.56]];

const CORRIDOR_MIN = 6;
/** Where a person arriving through a door stands: inside the room, clear of the first row or table. */
const ENTRY = 1.4;
const BUILDING_MIN = 24;
const DOOR = 2.6;
const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const areaOf = (room: VenueRoom) => Math.max(SPACE[room.kind].min, SPACE[room.kind].base + room.capacity * SPACE[room.kind].perPerson);

const WEST_KINDS: RoomKind[] = ["hall", "workshop", "posters"];
const EAST_KINDS: RoomKind[] = ["exhibition", "lounge"];

// ── The plan ──────────────────────────────────────────────────────────────────

/** Which side each side room goes on: D10's sides, with posters and workshops moving east when the west runs much longer. */
function sides(rooms: VenueRoom[], width: (side: VenueRoom[]) => number) {
  const west = rooms.filter((r) => WEST_KINDS.includes(r.kind));
  const east = rooms.filter((r) => EAST_KINDS.includes(r.kind));
  const len = (side: VenueRoom[]) => side.reduce((n, r) => n + Math.max(9, areaOf(r) / width(side)), 0);
  for (const kind of ["posters", "workshop"] as RoomKind[]) {
    for (const r of [...west].reverse().filter((x) => x.kind === kind)) {
      if (len(west) - len(east) <= Math.max(9, areaOf(r) / width(west))) break;
      west.splice(west.indexOf(r), 1);
      east.push(r);
    }
  }
  return { west, east };
}

const sideWidth = (side: VenueRoom[]) => (side.length ? clamp(Math.round(Math.sqrt(Math.max(...side.map(areaOf))) * 0.95), 12, 34) : 0);

/** The building: every zone's rectangle, with the plenary and foyer across its full width. */
function planZones(rooms: VenueRoom[]) {
  const { west, east } = sides(rooms, sideWidth);
  const Ww = sideWidth(west);
  const We = sideWidth(east);
  // A side room's length along the corridor is its "across" (W); the side's width is door to far wall (D).
  const depths = (side: VenueRoom[], w: number) => side.map((r) => sizeToFit(r, clamp(areaOf(r) / w, 9, 70), 70, (len) => fits(r, len, w)));
  const dw = depths(west, Ww);
  const de = depths(east, We);
  const sum = (a: number[]) => a.reduce((n, d) => n + d, 0);
  const L = Math.max(sum(dw), sum(de), 14);
  // The shorter side's last room stretches to the plenary, so the building has no hollow corners.
  if (dw.length) dw[dw.length - 1] += L - sum(dw);
  if (de.length) de[de.length - 1] += L - sum(de);
  const B = Math.max(Ww + CORRIDOR_MIN + We, BUILDING_MIN);
  const C = B - Ww - We;
  const X0 = -B / 2;
  const X1 = B / 2;
  const cx0 = X0 + Ww;
  const cx1 = cx0 + C;
  const plenary = rooms.find((r) => r.kind === "plenary");
  const foyer = rooms.find((r) => r.kind === "foyer")!;
  const Df = Math.round(clamp(areaOf(foyer) / B, 12, 40) * 2) / 2;
  const Dp = plenary ? sizeToFit(plenary, clamp(areaOf(plenary) / B, 14, 80), 80, (d) => fits(plenary, B, d)) : 0;

  const zone = (room: VenueRoom, rect: Rect, spawn: [number, number, number], tint?: [number, number, number]): LayoutZone => ({
    id: room.id,
    name: room.name,
    sub: SUB[room.kind],
    kind: room.kind,
    rect: rect.map(r2) as Rect,
    ceil: CEIL[room.kind],
    spawn: spawn.map(r2) as [number, number, number],
    floor: FLOOR[room.kind],
    capacity: room.capacity,
    ...(tint && { tint }),
  });
  const ccx = (cx0 + cx1) / 2;
  const zones: LayoutZone[] = [zone(foyer, [X0, 0, X1, Df], [ccx, Df - 3, Math.PI])];
  zones.push({ id: "corridor", name: "Main Corridor", sub: SUB.corridor, kind: "corridor", rect: [cx0, -L, cx1, 0].map(r2) as Rect, ceil: CEIL.corridor, spawn: [r2(ccx), -2, r2(Math.PI)], floor: "marble", capacity: 0 });
  let z = 0;
  let hallN = 0;
  west.forEach((room, i) => {
    const rect: Rect = [X0, z - dw[i], cx0, z];
    zones.push(zone(room, rect, [cx0 - ENTRY, z - dw[i] / 2, -Math.PI / 2], room.kind === "hall" ? HALL_TINTS[hallN++ % HALL_TINTS.length] : undefined));
    z -= dw[i];
  });
  z = 0;
  east.forEach((room, i) => {
    const rect: Rect = [cx1, z - de[i], X1, z];
    zones.push(zone(room, rect, [cx1 + ENTRY, z - de[i] / 2, Math.PI / 2], room.kind === "hall" ? HALL_TINTS[hallN++ % HALL_TINTS.length] : undefined));
    z -= de[i];
  });
  if (plenary) zones.push(zone(plenary, [X0, -L - Dp, X1, -L], [ccx, -L - ENTRY, Math.PI]));
  return { zones, west: west.map((r) => r.id), east: east.map((r) => r.id), B, L, Df, Dp, X0, X1, cx0, cx1 };
}

// ── What fits: how much of a room's furniture a W x D room holds, by the furnishers' own spacing ──

const theatreRows = (D: number, big: boolean) => {
  const sv0 = D - 0.4 - (big ? 5 : 3.2);
  return sv0 - 1.8 >= 2.6 ? Math.floor((sv0 - 1.8 - 2.6) / 1.15) + 1 : 0;
};
const theatreSeats = (W: number, D: number, big: boolean) => theatreRows(D, big) * 2 * Math.max(0, Math.floor((W / 2 - 1.4 - 1.2) / 0.62));
const workshopTables = (W: number, D: number) => (W >= 5.2 && D >= 7 ? (Math.floor((W - 5.2) / 5) + 1) * (Math.floor((D - 7) / 5) + 1) : 0);
const posterBoards = (W: number, D: number) => Math.max(1, Math.floor((W - 4) / 4.2)) * (D >= 5.4 ? Math.floor((D - 5.4) / 3) + 1 : 0);
const posterBoardsWanted = (capacity: number) => clamp(Math.round(capacity / 5), 6, 40);

/** Does a W (across) by D (door to far wall) room hold this room's people? */
function fits(room: VenueRoom, W: number, D: number): boolean {
  switch (room.kind) {
    case "plenary":
    case "hall":
      return theatreSeats(W, D, room.kind === "plenary") >= Math.min(room.capacity, MAX_SEATS_DRAWN);
    case "workshop":
      return workshopTables(W, D) * 6 >= room.capacity;
    case "posters":
      return posterBoards(W, D) >= posterBoardsWanted(room.capacity);
    case "exhibition":
      return standCols(W) * standRows(D) >= standsWanted(room.capacity);
    default:
      return true;
  }
}

/** The smallest size (in 0.5 m steps, from `start`) at which the room holds its people, up to `max`. */
function sizeToFit(room: VenueRoom, start: number, max: number, holds: (size: number) => boolean): number {
  let size = Math.round(start * 2) / 2;
  while (size < max && !holds(size)) size += 0.5;
  return size;
}

// ── Frames: furnish a room from its door (v = 0) to its far wall (v = D) ─────

interface Frame {
  zone: LayoutZone;
  /** Across the room. */
  W: number;
  /** Door to far wall. */
  D: number;
  /** Facing the far wall. */
  yaw: number;
  at: (u: number, v: number) => [number, number];
  box: (u0: number, v0: number, u1: number, v1: number) => { x0: number; z0: number; x1: number; z1: number };
}

function frame(zone: LayoutZone, door: "east" | "west" | "south"): Frame {
  const [x0, z0, x1, z1] = zone.rect;
  const xc = (x0 + x1) / 2;
  const zc = (z0 + z1) / 2;
  const FRAMES = {
    // Door in the east wall: the room runs west, u runs north to south.
    east: { at: (u: number, v: number): [number, number] => [r2(x1 - v), r2(zc + u)], W: z1 - z0, D: x1 - x0, yaw: -Math.PI / 2 },
    west: { at: (u: number, v: number): [number, number] => [r2(x0 + v), r2(zc - u)], W: z1 - z0, D: x1 - x0, yaw: Math.PI / 2 },
    // Door (or entrance) in the south wall: the room runs north, u runs west to east.
    south: { at: (u: number, v: number): [number, number] => [r2(xc + u), r2(z1 - v)], W: x1 - x0, D: z1 - z0, yaw: Math.PI },
  };
  const { at, W, D, yaw } = FRAMES[door];
  const box = (u0: number, v0: number, u1: number, v1: number) => {
    const [ax, az] = at(u0, v0);
    const [bx, bz] = at(u1, v1);
    return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
  };
  return { zone, W, D, yaw, at, box };
}

const MAX_SEATS_DRAWN = 420;

interface Out {
  items: LayoutItem[];
  people: LayoutPerson[];
  hotspots: LayoutHotspot[];
}

/** Stage, screen, lectern and rows of seats facing them: the plenary and the parallel halls. */
function furnishTheatre(f: Frame, out: Out) {
  const id = f.zone.id;
  const big = f.zone.kind === "plenary";
  const stageD = big ? 5 : 3.2;
  const sv0 = f.D - 0.4 - stageD;
  const halfStage = Math.min(f.W / 2 - 1.5, big ? Math.max(8, f.W * 0.35) : f.W / 2 - 1.5);
  out.items.push({ t: "stage", zone: id, solid: true, h: big ? 0.9 : 0.45, foot: f.box(-halfStage, sv0, halfStage, f.D - 0.4) });
  const sw = big ? Math.min(14, f.W * 0.45) : Math.min(8, f.W - 4);
  const [sx, sz] = f.at(0, f.D - 0.25);
  out.items.push({
    t: "screen", zone: id, solid: false, foot: f.box(-sw / 2, f.D - 0.35, sw / 2, f.D - 0.15),
    id: big ? "plenary-main" : `${id}-screen`, x: sx, y: big ? 4.6 : 3.3, z: sz, w: r2(sw), hgt: r2(sw * 0.55), yaw: f.yaw + Math.PI,
    kicker: `${f.zone.name} · ${big ? "Main stage" : "Parallel session"}`, title: big ? "Plenary session" : "Session to be announced", sub: "The agenda names this room's sessions",
  });
  const lu = halfStage * 0.6;
  out.items.push({ t: "lectern", zone: id, solid: true, foot: f.box(lu - 0.4, sv0 + stageD / 2 - 0.3, lu + 0.4, sv0 + stageD / 2 + 0.3) });
  const [px, pz] = f.at(lu - 0.9, sv0 + stageD / 2);
  out.people.push({ x: px, z: pz, y: big ? 0.9 : 0.45, yaw: r2(f.yaw + Math.PI), pose: "present", role: "speaker" });
  // Two blocks of rows with a centre aisle and side aisles, filled from the front until the room's capacity.
  const blocks: [number, number][] = [[-f.W / 2 + 1.4, -1.2], [1.2, f.W / 2 - 1.4]];
  let left = Math.min(f.zone.capacity, MAX_SEATS_DRAWN);
  for (let v = sv0 - 1.8; v >= 2.6 && left > 0; v -= 1.15) {
    for (const [b0, b1] of blocks) {
      const n = Math.min(Math.floor((b1 - b0) / 0.62), left);
      if (n < 1) continue;
      left -= n;
      const p0 = f.at(b0 + 0.31, v);
      const p1 = f.at(b0 + 0.31 + (n - 1) * 0.62, v);
      out.items.push({ t: "row", zone: id, solid: true, p0, p1, n, yaw: f.yaw, foot: f.box(b0, v - 0.3, b0 + n * 0.62, v + 0.28) });
    }
  }
  if (big) {
    const [tx, tz] = f.at(-f.W / 2 + 2.5, 1.6);
    out.people.push({ x: tx, z: tz, yaw: f.yaw, pose: "stand", role: "tech" });
  }
  const [hx, hz] = f.at(0, Math.max(2, sv0 - 3));
  out.hotspots.push({
    id: big ? "plenary-screen" : `${id}-screen`, x: hx, z: hz, r: 6, kind: "screen",
    prompt: big ? "Watch the plenary" : "Watch this session", title: `${f.zone.name} · ${big ? "Main stage" : "Parallel session"}`,
    body: "This room's sessions and recordings come from the event's agenda in EA-SYS.",
  });
}

function furnishWorkshop(f: Frame, out: Out) {
  const id = f.zone.id;
  const sw = Math.min(7, f.W - 4);
  const [sx, sz] = f.at(0, f.D - 0.25);
  out.items.push({
    t: "screen", zone: id, solid: false, foot: f.box(-sw / 2, f.D - 0.35, sw / 2, f.D - 0.15), id: `${id}-screen`, x: sx, y: 3, z: sz, w: r2(sw), hgt: r2(sw * 0.55),
    yaw: f.yaw + Math.PI, kicker: f.zone.name, title: "Hands-on workshop", sub: "Workshop titles come from the agenda",
  });
  // Tables with their chairs reach 1.75 m from the centre; 5 m apart leaves a 1.5 m aisle between them.
  let left = Math.ceil(f.zone.capacity / 6);
  for (let v = 3.6; v <= f.D - 3.4 && left > 0; v += 5) {
    for (let u = -f.W / 2 + 2.6; u <= f.W / 2 - 2.6 && left > 0; u += 5) {
      const [cx, cz] = f.at(u, v);
      out.items.push({ t: "round", zone: id, solid: true, cx, cz, chairs: 6, foot: { cx, cz, r: 1.75 } });
      left--;
    }
  }
  const [hx, hz] = f.at(0, 1.8);
  out.hotspots.push({ id, x: hx, z: hz, r: 4, kind: "info", prompt: "About this room", title: f.zone.name, body: "Round tables for small-group, hands-on sessions. Workshop titles come from the event's agenda." });
}

function furnishPosters(f: Frame, out: Out) {
  const id = f.zone.id;
  let left = clamp(Math.round(f.zone.capacity / 5), 6, 40);
  const lanes = Math.max(1, Math.floor((f.W - 4) / 4.2));
  for (let v = 3.4; v <= f.D - 2 && left > 0; v += 3) {
    for (let i = 0; i < lanes && left > 0; i++) {
      const u = -((lanes - 1) * 4.2) / 2 + i * 4.2;
      out.items.push({ t: "poster", zone: id, solid: true, yaw: f.yaw, foot: f.box(u - 1.1, v - 0.08, u + 1.1, v + 0.08) });
      left--;
    }
  }
  const [hx, hz] = f.at(0, 1.8);
  out.hotspots.push({ id, x: hx, z: hz, r: 4, kind: "info", prompt: "About the posters", title: f.zone.name, body: "Poster boards for the event's accepted abstracts." });
}

// Exhibition grid: rows of 3 m stands facing the door, a 3.6 m aisle in front of each row, and
// 1.8 m aisles down both sides joining the rows.
const STAND = 3;
const STAND_PITCH = 3.6;
const STAND_ROW = 6.6;
const standCols = (W: number) => Math.max(0, Math.floor((W - 3.6 + 0.6) / STAND_PITCH));
const standRows = (D: number) => (D - 1.5 >= 3.6 + STAND ? Math.floor((D - 1.5 - 3.6 - STAND) / STAND_ROW) + 1 : 0);
const standsWanted = (capacity: number) => clamp(Math.round(capacity / 25), 4, 24);

function furnishExhibition(f: Frame, out: Out) {
  const id = f.zone.id;
  const cols = standCols(f.W);
  let left = standsWanted(f.zone.capacity);
  let n = 0;
  const face = r2(f.yaw + Math.PI);
  const u0 = -((cols * STAND_PITCH - 0.6) / 2);
  for (let row = 0; row < standRows(f.D) && left > 0; row++) {
    const v = 3.6 + row * STAND_ROW;
    for (let c = 0; c < cols && left > 0; c++, left--) {
      const u = u0 + c * STAND_PITCH;
      n++;
      out.items.push({ t: "stand", zone: id, solid: true, face, label: `Stand ${n}`, tier: n <= 2 ? 1 : 2, n, foot: f.box(u, v, u + STAND, v + STAND) });
      const [px, pz] = f.at(u + STAND / 2, v + 0.6);
      out.people.push({ x: px, z: pz, yaw: face, pose: "stand", role: "exhibitor" });
      const [hx, hz] = f.at(u + STAND / 2, v - 1.6);
      out.hotspots.push({ id: `stand-${n}`, x: r2(hx), z: r2(hz), r: 2.2, kind: "stand", prompt: `Visit Stand ${n}`, title: `Stand ${n}`, body: "No sponsor has this stand yet. Sponsors added in EA-SYS take the stands in tier order." });
    }
  }
  // No room-wide hotspot here: the first row's stand hotspots sit at the door, and walking up to the
  // room's own would open a stand instead (found by the venue's hotspot walk, phase 6 step 3).
}

function furnishLounge(f: Frame, out: Out) {
  const id = f.zone.id;
  const half = Math.min(5, f.W / 2 - 2);
  out.items.push({ t: "bar", zone: id, solid: true, yaw: r2(f.yaw + Math.PI), foot: f.box(-half, f.D - 1.6, half, f.D - 0.8) });
  for (const u of [-half / 2, half / 2]) {
    const [bx, bz] = f.at(u, f.D - 0.4);
    out.people.push({ x: bx, z: bz, yaw: r2(f.yaw + Math.PI), pose: "stand", role: "barista" });
  }
  const [cx, cz] = f.at(0, f.D - 2.6);
  out.hotspots.push({ id: `${id}-coffee`, x: cx, z: cz, r: 2.6, kind: "info", prompt: "Order a coffee", title: "Coffee Bar", body: "Coffee, tea and water between sessions." });
  for (let v = 3.6; v <= f.D - 5.5; v += 6) {
    for (const u of [-f.W / 4, f.W / 4]) {
      const [sx, sz] = f.at(u, v);
      out.items.push({ t: "sofa", zone: id, solid: true, yaw: r2(f.yaw), foot: f.box(u - 1.3, v - 1.7, u + 1.3, v + 1.7) });
      out.people.push({ x: r2(sx + 0.3), z: r2(sz), yaw: 0.8, pose: "talk", role: "guest" });
    }
  }
}

function furnishFoyer(f: Frame, entranceX: number, out: Out, eventName: string) {
  const id = f.zone.id;
  const v = f.D * 0.5;
  const deskW = Math.min(12, f.W * 0.28);
  for (const [u0, title, sub] of [[-f.W / 2 + 2.5, "Registration", "Badge collection · Delegate services"], [f.W / 2 - 2.5 - deskW, "Information", "Programme and venue help"]] as const) {
    out.items.push({ t: "desk", zone: id, solid: true, yaw: 0, title, sub: `${sub}`, foot: f.box(u0, v - 0.5, u0 + deskW, v + 0.5) });
    const staff = Math.max(2, Math.round(deskW / 4));
    for (let i = 0; i < staff; i++) {
      const [px, pz] = f.at(u0 + (i + 0.5) * (deskW / staff), v + 1.1);
      out.people.push({ x: px, z: pz, yaw: 0, pose: "stand", role: "staff" });
    }
    const [hx, hz] = f.at(u0 + deskW / 2, v - 1.6);
    out.hotspots.push({
      id: title, x: hx, z: hz, r: 3.2, kind: "info", prompt: title === "Registration" ? "Collect your badge" : "Ask the information desk",
      title: title === "Registration" ? "Registration & badge collection" : "Information desk",
      body: title === "Registration" ? `Delegates of ${eventName} collect their badges here on arrival.` : "Programme queries and venue help.",
    });
  }
  // The directory stands beside the line from the entrance to the corridor, never on it: east of the
  // line, or west when the corridor runs along the building's east edge.
  const line = entranceX - f.at(0, 0)[0];
  const du = line + 3.2 <= f.W / 2 - 2 ? line + 3.2 : line - 3.2;
  const [dx, dz] = f.at(du, 4.5);
  out.items.push({ t: "directory", zone: id, solid: true, yaw: 0, foot: { x0: r2(dx - 0.7), z0: r2(dz - 0.1), x1: r2(dx + 0.7), z1: r2(dz + 0.1) } });
  for (const [u, vv] of [[-f.W / 2 + 1.5, 1.5], [f.W / 2 - 1.5, 1.5], [-f.W / 2 + 1.5, f.D - 1.5], [f.W / 2 - 1.5, f.D - 1.5]]) {
    const [px, pz] = f.at(u, vv);
    out.items.push({ t: "plant", zone: id, solid: true, cx: px, cz: pz, s: 1.15, foot: { cx: px, cz: pz, r: 0.5 } });
  }
  for (const [u, vv] of [[-3, 5.5], [3, 6]]) {
    const [gx, gz] = f.at(u, vv);
    out.people.push({ x: gx, z: gz, yaw: r2(u > 0 ? -0.9 : 0.9), pose: "talk", role: "guest" });
  }
}

// ── Walls and doors ───────────────────────────────────────────────────────────

function buildWalls(p: ReturnType<typeof planZones>): { walls: LayoutWall[]; doors: LayoutDoor[] } {
  const { zones, B, L, Df, Dp, X0, X1, cx0, cx1 } = p;
  const byId = new Map(zones.map((z) => [z.id, z]));
  const walls: LayoutWall[] = [];
  const doors: LayoutDoor[] = [];
  const north = -L - Dp;
  const corridorCeil = CEIL.corridor;
  const ccx = (cx0 + cx1) / 2;
  const foyer = zones[0];
  const plenary = zones.find((z) => z.kind === "plenary");
  // Exterior: a glass entrance across the middle of the south façade.
  const glass = Math.min(B - 6, 24);
  walls.push({ axis: "x", k: Df, a0: X0, a1: X1, h: CEIL.foyer, opens: [{ a: r2(-glass / 2), b: r2(glass / 2), y1: 6.2, glass: true }] });
  walls.push({ axis: "x", k: north, a0: X0, a1: X1, h: 9, opens: [] });
  walls.push({ axis: "z", k: X0, a0: north, a1: Df, h: 9, opens: [] });
  walls.push({ axis: "z", k: X1, a0: north, a1: Df, h: 9, opens: [] });
  // Foyer to corridor: the corridor's full width, under a lintel.
  walls.push({ axis: "x", k: 0, a0: X0, a1: X1, h: CEIL.foyer, opens: [{ a: r2(cx0 + 0.3), b: r2(cx1 - 0.3), y1: 4.4 }] });
  doors.push({ x: r2(ccx), z: 0, width: r2(cx1 - cx0 - 0.6), axis: "x", between: [foyer.id, "corridor"] });
  // Corridor to plenary.
  if (plenary) {
    const w = Math.min(cx1 - cx0 - 1, 6);
    walls.push({ axis: "x", k: -L, a0: X0, a1: X1, h: 9, opens: [{ a: r2(ccx - w / 2), b: r2(ccx + w / 2), y1: 4.4 }] });
    doors.push({ x: r2(ccx), z: r2(-L), width: r2(w), axis: "x", between: ["corridor", plenary.id] });
  }
  // The corridor's side walls, a door into each room, and the walls between rooms on each side.
  for (const [ids, k, kWall] of [[p.west, cx0, "west"], [p.east, cx1, "east"]] as const) {
    if (!ids.length) continue;
    const opens: WallOpening[] = [];
    ids.forEach((id, i) => {
      const z = byId.get(id)!;
      const zc = (z.rect[1] + z.rect[3]) / 2;
      const w = z.kind === "exhibition" ? 4 : DOOR;
      opens.push({ a: r2(zc - w / 2), b: r2(zc + w / 2) });
      doors.push({ x: r2(k), z: r2(zc), width: w, axis: "z", between: ["corridor", id] });
      if (i > 0) walls.push({ axis: "x", k: z.rect[3], a0: kWall === "west" ? X0 : cx1, a1: kWall === "west" ? cx0 : X1, h: Math.max(z.ceil, byId.get(ids[i - 1])!.ceil), opens: [] });
    });
    const h = Math.max(corridorCeil, ...ids.map((id) => byId.get(id)!.ceil));
    walls.push({ axis: "z", k: r2(k), a0: r2(-L), a1: 0, h, opens });
  }
  return { walls: walls.map((w) => ({ ...w, k: r2(w.k), a0: r2(w.a0), a1: r2(w.a1) })), doors };
}

// ── Signs and routes ─────────────────────────────────────────────────────────

function doorSigns(p: ReturnType<typeof planZones>, doors: LayoutDoor[], out: Out) {
  const byId = new Map(p.zones.map((z) => [z.id, z]));
  for (const d of doors) {
    const room = byId.get(d.between[1]);
    if (!room || room.kind === "corridor") continue;
    if (d.axis === "z") {
      const westSide = d.x <= p.cx0 + 0.01;
      out.items.push({
        t: "sign", zone: "corridor", solid: false, foot: { x0: d.x - 0.1, z0: d.z - 2, x1: d.x + 0.1, z1: d.z + 2 },
        x: r2(d.x + (westSide ? 0.18 : -0.18)), y: 4.1, z: d.z, w: 4.4, hgt: 0.9, yaw: westSide ? r2(Math.PI / 2) : r2(-Math.PI / 2), kicker: "", title: room.name, sub: room.sub,
      });
    } else {
      out.items.push({
        t: "sign", zone: "corridor", solid: false, foot: { x0: d.x - 3, z0: d.z - 0.1, x1: d.x + 3, z1: d.z + 0.1 },
        x: d.x, y: 4.7, z: r2(d.z + 0.18), w: 7, hgt: 1.2, yaw: 0, kicker: "Main stage", title: room.name, sub: room.sub,
      });
    }
  }
}

function routes(p: ReturnType<typeof planZones>): [number, number][][] {
  const ccx = (p.cx0 + p.cx1) / 2;
  const out: [number, number][][] = [];
  const loop = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => [r2(x), r2(z)] as [number, number]);
  // Up and down the corridor, and a loop in front of the foyer desks.
  out.push(loop(ccx - 1.2, -p.L + 2, ccx + 1.2, -1.5));
  out.push(loop(ccx - 6, p.Df * 0.5 + 2.5, ccx + 6, p.Df - 3));
  return out;
}

// ── The whole layout ─────────────────────────────────────────────────────────

/** Which wall a room's door is in: the plenary's faces the corridor's end, side rooms face the corridor. */
function doorSide(z: LayoutZone, west: string[]): "south" | "east" | "west" {
  if (z.kind === "plenary") return "south";
  return west.includes(z.id) ? "east" : "west";
}

export function generateLayout(rooms: VenueRoom[], opts: { eventName: string }): VenueLayout {
  const p = planZones(rooms);
  const { walls, doors } = buildWalls(p);
  const out: Out = { items: [], people: [], hotspots: [] };
  for (const z of p.zones) {
    if (z.kind === "corridor") continue;
    if (z.kind === "foyer") {
      furnishFoyer(frame(z, "south"), (p.cx0 + p.cx1) / 2, out, opts.eventName);
      continue;
    }
    const f = frame(z, doorSide(z, p.west));
    if (z.kind === "plenary" || z.kind === "hall") furnishTheatre(f, out);
    else if (z.kind === "workshop") furnishWorkshop(f, out);
    else if (z.kind === "posters") furnishPosters(f, out);
    else if (z.kind === "exhibition") furnishExhibition(f, out);
    else if (z.kind === "lounge") furnishLounge(f, out);
  }
  doorSigns(p, doors, out);
  const north = -p.L - p.Dp;
  return {
    v: 1,
    bounds: [p.X0, north, p.X1, p.Df].map(r2) as Rect,
    zones: p.zones,
    walls,
    doors,
    items: out.items,
    people: out.people,
    hotspots: out.hotspots,
    routes: routes(p),
  };
}
