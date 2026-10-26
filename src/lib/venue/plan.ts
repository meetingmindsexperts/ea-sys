/**
 * A drawn floor plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, section 3.1):
 * where each room sits, which wall its door is in, the walkways and the
 * entrance. Stored in `Event.settings.venue.plan`; absent means AUTOMATIC
 * (the template in layout.ts, unchanged). The room list stays the source of
 * each room's identity (name, kind, capacity); the plan only adds geometry,
 * keyed by room id, so session matching and sponsors keep working.
 *
 * Coordinates are metres, +x east and -z north, as in layout.ts. Walls are
 * straight and axis-aligned (decision F1: turns in 90 degree steps), so every
 * room and walkway is a rectangle.
 *
 * Client-safe: pure, no Node imports. The building made from a plan is in
 * plan-layout.ts.
 */
import { z } from "zod";
import type { LayoutDoor, Rect, VenueLayout } from "./layout";
import type { VenueRoom } from "./rooms";

export const PLAN_WALLS = ["n", "s", "e", "w"] as const;
export type PlanWall = (typeof PLAN_WALLS)[number];

export interface PlanDoor {
  wall: PlanWall;
  /** The door's centre along its wall: an x for a north or south wall, a z for an east or west wall. */
  at: number;
  width: number;
}

/**
 * The floors a venue can have (owner, Oct 26: two for now, named Ground and Level 1). A room, walkway or
 * fixture with no `floor` is on the ground floor, so every plan saved before floors existed reads unchanged.
 */
export const PLAN_FLOORS = ["ground", "level-1"] as const;
export type PlanFloor = (typeof PLAN_FLOORS)[number];
export const FLOOR_NAME: Record<PlanFloor, string> = { ground: "Ground", "level-1": "Level 1" };

export interface PlacedRoom {
  id: string;
  rect: Rect;
  floor?: PlanFloor;
  /** The foyer's door is its way on into the building; its entrance is `VenuePlan.entrance`. */
  door: PlanDoor;
}

export interface PlanCorridor {
  id: string;
  name: string;
  rect: Rect;
  floor?: PlanFloor;
}

/** What can stand in a room or walkway besides its own furniture (floor plan editor, owner Oct 24). */
export const FIXTURE_KINDS = ["stairs", "lift", "toilets", "exit", "pillar", "catering", "registration", "photo-wall", "banner"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export const FIXTURE_INFO: Record<FixtureKind, { label: string; size: [number, number]; solid: boolean; help: string }> = {
  stairs: { label: "Stairs", size: [3, 6], solid: true, help: "A staircase; the arrow points up the flight." },
  lift: { label: "Lift", size: [2.6, 2.6], solid: true, help: "A lift; its doors face the arrow." },
  toilets: { label: "Toilets", size: [5, 6], solid: true, help: "Washrooms, as a block with a sign; their entrance faces the arrow." },
  exit: { label: "Emergency exit", size: [2, 0.4], solid: false, help: "An exit sign over a door; put it against a wall, facing the arrow." },
  pillar: { label: "Pillar", size: [0.8, 0.8], solid: true, help: "A column people walk around." },
  catering: { label: "Catering point", size: [5, 1.2], solid: true, help: "A coffee and lunch counter; staff stand behind it, guests come from the arrow's side." },
  // Owner, Oct 26: more for the foyer and any room.
  registration: { label: "Registration counter", size: [6, 1.2], solid: true, help: "An extra staffed counter where delegates collect badges; guests come from the arrow's side." },
  "photo-wall": { label: "Photo wall", size: [4, 0.4], solid: true, help: "A backdrop with the event's name for photos; people pose on the arrow's side." },
  banner: { label: "Standing banner", size: [1, 0.4], solid: true, help: "A roll-up banner showing its name; it faces the arrow." },
};

export interface PlanFixture {
  id: string;
  kind: FixtureKind;
  /** Shown on the plan and on its sign; the kind's label when empty. */
  name: string;
  rect: Rect;
  /** The way it faces: where its front, door or arrow points. */
  dir: PlanWall;
  floor?: PlanFloor;
}

export interface VenuePlan {
  v: 1;
  /** In drawing order; the building's zones follow it. */
  rooms: PlacedRoom[];
  corridors: PlanCorridor[];
  /** The glass entrance, in an outside wall of the foyer. */
  entrance: PlanDoor;
  /** Stairs, lifts, toilets, exits, pillars and catering points, each inside a room or walkway. */
  fixtures: PlanFixture[];
  /**
   * Editor only, on one floor's view of a plan: the ids the other floor uses, so a walkway or fixture added
   * there never repeats one. The schema drops it, so it is never saved.
   */
  otherIds?: string[];
}

/**
 * How far from the origin a plan may reach, in metres. The automatic layout's
 * largest building (every kind at its most, the "edge-largest" fixture) is
 * 388 m deep, and a plan must hold anything the automatic layout makes.
 */
export const PLAN_EXTENT = 600;
/** The smallest room or walkway side, in metres. */
export const PLAN_MIN_SIDE = 3;
/** Door widths, in metres. */
export const PLAN_DOOR_MIN = 1.2;
export const PLAN_DOOR_MAX = 30;

const coord = z.number().finite().min(-PLAN_EXTENT).max(PLAN_EXTENT);
const rectSchema = z
  .tuple([coord, coord, coord, coord])
  .refine(([x0, z0, x1, z1]) => x1 - x0 >= PLAN_MIN_SIDE && z1 - z0 >= PLAN_MIN_SIDE, `Every room and walkway is at least ${PLAN_MIN_SIDE} m each way`);
const doorSchema = z.object({
  wall: z.enum(PLAN_WALLS),
  at: coord,
  width: z.number().finite().min(PLAN_DOOR_MIN, `A door is at least ${PLAN_DOOR_MIN} m wide`).max(PLAN_DOOR_MAX, `A door is at most ${PLAN_DOOR_MAX} m wide`),
});
/** The most walkways a plan holds. */
export const PLAN_MAX_WALKWAYS = 12;
/** The most fixtures a plan holds. */
export const PLAN_MAX_FIXTURES = 60;
/** A fixture's smallest side: a pillar can be thin, an exit sign thinner. */
export const FIXTURE_MIN_SIDE = 0.3;
const floorSchema = z.enum(PLAN_FLOORS).optional();
const fixtureRect = z
  .tuple([coord, coord, coord, coord])
  .refine(([x0, z0, x1, z1]) => x1 - x0 >= FIXTURE_MIN_SIDE && z1 - z0 >= FIXTURE_MIN_SIDE && x1 - x0 <= 40 && z1 - z0 <= 40, "A fixture is between 0.3 m and 40 m each way");

export const planSchema = z.object({
  v: z.literal(1),
  rooms: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), rect: rectSchema, door: doorSchema, floor: floorSchema })).min(1).max(20),
  corridors: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1, "Every walkway needs a name").max(60), rect: rectSchema, floor: floorSchema }))
    .max(PLAN_MAX_WALKWAYS, `A plan has at most ${PLAN_MAX_WALKWAYS} walkways`),
  entrance: doorSchema,
  // Plans saved before fixtures existed have none.
  fixtures: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), kind: z.enum(FIXTURE_KINDS), name: z.string().trim().max(60), rect: fixtureRect, dir: z.enum(PLAN_WALLS), floor: floorSchema }))
    .max(PLAN_MAX_FIXTURES, `A plan has at most ${PLAN_MAX_FIXTURES} stairs, lifts, counters and other fixtures, on both floors together`)
    .default([]),
});

export interface StoredVenuePlan {
  plan: VenuePlan;
  /** Milliseconds; the version a save must name, as for the room list. */
  updatedAt: number;
  updatedBy: string;
}

/** The saved plan in `Event.settings.venue.plan`, or null when the venue is automatic (or the saved plan no longer parses). */
export function readVenuePlan(settings: unknown): StoredVenuePlan | null {
  const venue = settings && typeof settings === "object" ? (settings as Record<string, unknown>).venue : null;
  const stored = venue && typeof venue === "object" ? (venue as Record<string, unknown>).plan : null;
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;
  const plan = planSchema.safeParse(s.plan);
  if (!plan.success) return null;
  return { plan: plan.data, updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0, updatedBy: typeof s.updatedBy === "string" ? s.updatedBy : "" };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

const EPS = 0.01;

/** The wall of `rect` a door at (x, z) sits in, or null when it is on none. */
function wallOf(rect: Rect, x: number, z: number): PlanWall | null {
  const [x0, z0, x1, z1] = rect;
  if (Math.abs(z - z0) < EPS && x > x0 - EPS && x < x1 + EPS) return "n";
  if (Math.abs(z - z1) < EPS && x > x0 - EPS && x < x1 + EPS) return "s";
  if (Math.abs(x - x0) < EPS && z > z0 - EPS && z < z1 + EPS) return "w";
  if (Math.abs(x - x1) < EPS && z > z0 - EPS && z < z1 + EPS) return "e";
  return null;
}

/** A door's centre point on its room's wall. */
export function doorPoint(rect: Rect, door: PlanDoor): [number, number] {
  const [x0, z0, x1, z1] = rect;
  if (door.wall === "n") return [door.at, z0];
  if (door.wall === "s") return [door.at, z1];
  if (door.wall === "w") return [x0, door.at];
  return [x1, door.at];
}

/** How long a wall of the rectangle is, and where along it it starts. */
export function wallSpan(rect: Rect, wall: PlanWall): [number, number] {
  const [x0, z0, x1, z1] = rect;
  return wall === "n" || wall === "s" ? [x0, x1] : [z0, z1];
}

// ── From the automatic layout ────────────────────────────────────────────────

/**
 * The automatic layout as a drawn plan: what "Edit the floor plan" starts
 * from, so the organiser begins from the building they already see. Built
 * back with `layoutFromPlan`, it gives the same building (the round-trip
 * test in venue-plan.test.ts).
 */
export function planFromLayout(layout: VenueLayout): VenuePlan {
  const doorFor = (id: string): LayoutDoor | undefined => layout.doors.find((d) => d.between.includes(id));
  const rooms: PlacedRoom[] = [];
  for (const z of layout.zones) {
    if (z.kind === "corridor") continue;
    const d = doorFor(z.id);
    rooms.push({ id: z.id, rect: z.rect, door: d ? toPlanDoor(z.rect, d.x, d.z, d.width) : { wall: "n", at: (z.rect[0] + z.rect[2]) / 2, width: 2.6 } });
  }
  const foyer = layout.zones.find((z) => z.kind === "foyer");
  let entrance: PlanDoor = { wall: "s", at: 0, width: 6 };
  for (const w of layout.walls) {
    for (const o of w.opens) {
      if (!o.glass || !foyer) continue;
      const mid = (o.a + o.b) / 2;
      const [x, zz] = w.axis === "x" ? [mid, w.k] : [w.k, mid];
      entrance = toPlanDoor(foyer.rect, x, zz, o.b - o.a);
    }
  }
  const corridors = layout.zones.filter((z) => z.kind === "corridor").map((z) => ({ id: z.id, name: z.name, rect: z.rect }));
  return { v: 1, rooms, corridors, entrance, fixtures: [] };
}

function toPlanDoor(rect: Rect, x: number, z: number, width: number): PlanDoor {
  const wall = wallOf(rect, x, z) ?? "s";
  return { wall, at: wall === "n" || wall === "s" ? x : z, width };
}

// ── Shape rules ──────────────────────────────────────────────────────────────

/**
 * The fixtures some room or walkway still holds. A room removed from the list
 * takes the stairs, toilets or exit standing in it with it, or they would fail
 * the plan's checks and switch the venue back to automatic (review MED, Oct 24).
 */
export function heldFixtures(plan: VenuePlan): PlanFixture[] {
  const areas = [...plan.rooms, ...plan.corridors];
  return plan.fixtures.filter((f) => areas.some((a) => floorOf(a) === floorOf(f) && within(f.rect, a.rect)));
}

// ── Floors ───────────────────────────────────────────────────────────────────

export const floorOf = (a: { floor?: PlanFloor }): PlanFloor => a.floor ?? "ground";

/** The floors a plan has rooms or walkways on, ground first; always at least the ground floor. */
export function planFloors(plan: VenuePlan): PlanFloor[] {
  const used = new Set([...plan.rooms, ...plan.corridors].map(floorOf));
  return PLAN_FLOORS.filter((f) => f === "ground" || used.has(f));
}

/** One floor of a plan as a plan of its own: what the editor edits, and what each floor's building is made from. */
export function floorView(plan: VenuePlan, floor: PlanFloor): VenuePlan {
  const on = (a: { floor?: PlanFloor }) => floorOf(a) === floor;
  const off = (a: { id: string; floor?: PlanFloor }) => !on(a);
  return {
    v: 1,
    rooms: plan.rooms.filter(on),
    corridors: plan.corridors.filter(on),
    entrance: plan.entrance,
    fixtures: plan.fixtures.filter(on),
    otherIds: [...plan.rooms.filter(off), ...plan.corridors.filter(off), ...plan.fixtures.filter(off)].map((a) => a.id),
  };
}

/** `a` on `floor`: the ground floor is written as no floor at all, as plans saved before floors were. */
export function onFloor<T extends { floor?: PlanFloor }>(a: T, floor: PlanFloor): T {
  const rest = { ...a };
  delete rest.floor;
  return floor === "ground" ? rest : { ...rest, floor };
}

/** Replace one floor's areas with an edited view's, keeping every list in its order (so an untouched plan stays equal). */
function mergeFloor<T extends { id: string; floor?: PlanFloor }>(all: T[], floor: PlanFloor, edited: T[]): T[] {
  const byId = new Map(edited.map((e) => [e.id, onFloor(e, floor)]));
  const out = all.flatMap((a) => {
    if (floorOf(a) !== floor) return [a];
    const e = byId.get(a.id);
    return e ? [e] : [];
  });
  const had = new Set(all.filter((a) => floorOf(a) === floor).map((a) => a.id));
  for (const e of edited) if (!had.has(e.id)) out.push(onFloor(e, floor));
  return out;
}

/** A plan with one floor replaced by an edited view of that floor. */
export function withFloor(plan: VenuePlan, floor: PlanFloor, view: VenuePlan): VenuePlan {
  return {
    v: 1,
    rooms: mergeFloor(plan.rooms, floor, view.rooms),
    corridors: mergeFloor(plan.corridors, floor, view.corridors),
    entrance: view.entrance,
    fixtures: mergeFloor(plan.fixtures, floor, view.fixtures),
  };
}

/** Kinds that join floors: a lift serves every floor it is drawn on, stairs the floors either side (decision F10). */
const LINKING: ReadonlySet<FixtureKind> = new Set(["stairs", "lift"]);

/**
 * The stairs and lifts that join Level 1 to the ground floor: the same kind, drawn in the same place on both
 * (a stairwell or a lift shaft stands over itself). Each upper one joins the first lower one under it.
 */
export function floorLinks(plan: VenuePlan): { lower: PlanFixture; upper: PlanFixture }[] {
  const links: { lower: PlanFixture; upper: PlanFixture }[] = [];
  for (const upper of plan.fixtures) {
    if (floorOf(upper) !== "level-1" || !LINKING.has(upper.kind)) continue;
    const lower = plan.fixtures.find((f) => floorOf(f) === "ground" && f.kind === upper.kind && overlapArea(f.rect, upper.rect) > EPS);
    if (lower) links.push({ lower, upper });
  }
  return links;
}

/** The point `d` metres out from the middle of the side a fixture faces. */
function frontOf(f: PlanFixture, d: number): [number, number] {
  const [x0, z0, x1, z1] = f.rect;
  const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
  if (f.dir === "n") return [cx, z0 - d];
  if (f.dir === "s") return [cx, z1 + d];
  if (f.dir === "w") return [x0 - d, cz];
  return [x1 + d, cz];
}

/** `inner` lies wholly inside `outer`. */
const within = (inner: Rect, outer: Rect) => inner[0] >= outer[0] - EPS && inner[1] >= outer[1] - EPS && inner[2] <= outer[2] + EPS && inner[3] <= outer[3] + EPS;

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * What is wrong with a plan for this room list, in words a person can act on
 * (section 3.3, layer 1). Walkability is checked separately, on the building
 * the plan makes (checkLayout).
 */
export function planIssues(rooms: VenueRoom[], plan: VenuePlan): string[] {
  const issues: string[] = [];
  const names = new Map(rooms.map((r) => [r.id, r.name]));
  const placed = new Map(plan.rooms.map((p) => [p.id, p]));
  for (const r of rooms) if (!placed.has(r.id)) issues.push(`${r.name} is not on the plan yet`);
  for (const p of plan.rooms) if (!names.has(p.id)) issues.push(`The plan has a room that is not on the room list (${p.id})`);
  if (placed.size !== plan.rooms.length) issues.push("A room is on the plan twice");

  const ids = new Set<string>();
  for (const c of plan.corridors) {
    if (names.has(c.id) || ids.has(c.id)) issues.push(`Walkway "${c.name}" shares its id with another area`);
    ids.add(c.id);
  }

  // Areas overlap, and fixtures stand in them, only on their own floor.
  const areas = [
    ...plan.rooms.map((p) => ({ name: names.get(p.id) ?? p.id, rect: p.rect, floor: floorOf(p) })),
    ...plan.corridors.map((c) => ({ name: c.name, rect: c.rect, floor: floorOf(c) })),
  ];
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (areas[i].floor === areas[j].floor && overlapArea(areas[i].rect, areas[j].rect) > EPS) issues.push(`${areas[i].name} and ${areas[j].name} overlap`);
    }
  }

  for (const p of plan.rooms) {
    const name = names.get(p.id) ?? p.id;
    const [a0, a1] = wallSpan(p.rect, p.door.wall);
    if (p.door.at - p.door.width / 2 < a0 - EPS || p.door.at + p.door.width / 2 > a1 + EPS) {
      issues.push(`${name}: its door does not fit on its wall`);
    }
  }

  // Each fixture stands wholly inside one room or walkway on its floor, and fixtures do not overlap each other.
  const fixtureIds = new Set<string>();
  const labelOf = (f: PlanFixture) => f.name || FIXTURE_INFO[f.kind].label;
  for (const f of plan.fixtures) {
    if (fixtureIds.has(f.id) || names.has(f.id) || ids.has(f.id)) issues.push(`${labelOf(f)} shares its id with another part of the plan`);
    fixtureIds.add(f.id);
    if (!areas.some((a) => a.floor === floorOf(f) && within(f.rect, a.rect))) issues.push(`${labelOf(f)} is not inside a room or walkway`);
  }
  for (let i = 0; i < plan.fixtures.length; i++) {
    for (let j = i + 1; j < plan.fixtures.length; j++) {
      const a = plan.fixtures[i];
      const b = plan.fixtures[j];
      if (floorOf(a) === floorOf(b) && overlapArea(a.rect, b.rect) > EPS) issues.push(`${labelOf(a)} and ${labelOf(b)} overlap`);
    }
  }

  // A counter or photo wall is used from the side it faces, so that side must open into the room (review MED).
  for (const f of plan.fixtures) {
    if (f.kind !== "registration" && f.kind !== "photo-wall") continue;
    const host = areas.find((a) => a.floor === floorOf(f) && within(f.rect, a.rect));
    const [x, z] = frontOf(f, 1.5);
    if (host && !(x > host.rect[0] && x < host.rect[2] && z > host.rect[1] && z < host.rect[3])) issues.push(`${labelOf(f)} faces a wall. Turn it so its arrow points into the room.`);
  }

  const foyer = rooms.find((r) => r.kind === "foyer");
  const foyerPlaced = foyer ? placed.get(foyer.id) : undefined;
  if (foyerPlaced && floorOf(foyerPlaced) !== "ground") issues.push(`${foyer!.name} is the way in, so it stays on the ground floor`);
  if (foyerPlaced) {
    const [a0, a1] = wallSpan(foyerPlaced.rect, plan.entrance.wall);
    if (plan.entrance.at - plan.entrance.width / 2 < a0 - EPS || plan.entrance.at + plan.entrance.width / 2 > a1 + EPS) {
      issues.push("The entrance does not fit on the foyer's wall");
    }
  }

  // Level 1 is reached by stairs or a lift drawn in the same place on both floors.
  if (planFloors(plan).includes("level-1")) {
    const links = floorLinks(plan);
    const joined = new Set(links.map((l) => l.upper.id));
    for (const f of plan.fixtures) {
      if (floorOf(f) !== "level-1" || !LINKING.has(f.kind) || joined.has(f.id)) continue;
      const kind = FIXTURE_INFO[f.kind].label.toLowerCase();
      const below = areas.some((a) => a.floor === "ground" && within(f.rect, a.rect));
      const first = below ? "Select it and click" : "Draw a room or walkway on the ground floor under it, then select it and click";
      issues.push(`${labelOf(f)} on Level 1 has no ${kind} under it on the ground floor. ${first} "Put the matching ${kind} on Ground".`);
    }
    if (!plan.fixtures.some((f) => floorOf(f) === "level-1" && LINKING.has(f.kind))) issues.push("Level 1 needs stairs or a lift, drawn in the same place on both floors");
  }
  return issues;
}
