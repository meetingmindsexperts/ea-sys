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

export interface PlacedRoom {
  id: string;
  rect: Rect;
  /** The foyer's door is its way on into the building; its entrance is `VenuePlan.entrance`. */
  door: PlanDoor;
}

export interface PlanCorridor {
  id: string;
  name: string;
  rect: Rect;
}

export interface VenuePlan {
  v: 1;
  /** In drawing order; the building's zones follow it. */
  rooms: PlacedRoom[];
  corridors: PlanCorridor[];
  /** The glass entrance, in an outside wall of the foyer. */
  entrance: PlanDoor;
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

export const planSchema = z.object({
  v: z.literal(1),
  rooms: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), rect: rectSchema, door: doorSchema })).min(1).max(20),
  corridors: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1, "Every walkway needs a name").max(60), rect: rectSchema }))
    .max(PLAN_MAX_WALKWAYS, `A plan has at most ${PLAN_MAX_WALKWAYS} walkways`),
  entrance: doorSchema,
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
  return { v: 1, rooms, corridors, entrance };
}

function toPlanDoor(rect: Rect, x: number, z: number, width: number): PlanDoor {
  const wall = wallOf(rect, x, z) ?? "s";
  return { wall, at: wall === "n" || wall === "s" ? x : z, width };
}

// ── Shape rules ──────────────────────────────────────────────────────────────

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

  const areas = [
    ...plan.rooms.map((p) => ({ name: names.get(p.id) ?? p.id, rect: p.rect })),
    ...plan.corridors.map((c) => ({ name: c.name, rect: c.rect })),
  ];
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (overlapArea(areas[i].rect, areas[j].rect) > EPS) issues.push(`${areas[i].name} and ${areas[j].name} overlap`);
    }
  }

  for (const p of plan.rooms) {
    const name = names.get(p.id) ?? p.id;
    const [a0, a1] = wallSpan(p.rect, p.door.wall);
    if (p.door.at - p.door.width / 2 < a0 - EPS || p.door.at + p.door.width / 2 > a1 + EPS) {
      issues.push(`${name}: its door does not fit on its wall`);
    }
  }

  const foyer = rooms.find((r) => r.kind === "foyer");
  const foyerPlaced = foyer ? placed.get(foyer.id) : undefined;
  if (foyerPlaced) {
    const [a0, a1] = wallSpan(foyerPlaced.rect, plan.entrance.wall);
    if (plan.entrance.at - plan.entrance.width / 2 < a0 - EPS || plan.entrance.at + plan.entrance.width / 2 > a1 + EPS) {
      issues.push("The entrance does not fit on the foyer's wall");
    }
  }
  return issues;
}
