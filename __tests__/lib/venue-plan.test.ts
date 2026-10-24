/**
 * Drawn floor plans (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, phase 0). The
 * acceptance test: every automatic layout, turned into a plan and built back
 * from it, is the same building: the same zones, doors, furniture, people,
 * hotspots, crowd loops and outline, walls with the same solid stretches and
 * openings, and walkable. Then the shape rules and the generic builder on
 * plans the template could never make.
 */
import { describe, it, expect } from "vitest";
import { generateLayout, type LayoutItem, type LayoutWall, type Rect, type VenueLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { LAYOUT_FIXTURES } from "@/lib/venue/layout-fixtures";
import { planFromLayout, planIssues, planSchema, readVenuePlan, type VenuePlan } from "@/lib/venue/plan";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import type { VenueRoom } from "@/lib/venue/rooms";

/** A wall's solid stretches and openings, merged per line, so two ways of cutting the same wall compare equal. */
function wallMap(walls: LayoutWall[]) {
  const lines = new Map<string, { solid: [number, number][]; glass: [number, number][]; lintel: [number, number, number | undefined][] }>();
  for (const w of walls) {
    const key = `${w.axis}:${w.k}`;
    const line = lines.get(key) ?? { solid: [], glass: [], lintel: [] };
    let cur = w.a0;
    for (const o of [...w.opens].sort((p, q) => p.a - q.a)) {
      if (o.glass) {
        line.glass.push([o.a, o.b]);
        continue;
      }
      line.lintel.push([o.a, o.b, o.y1]);
      if (o.a > cur) line.solid.push([cur, o.a]);
      cur = o.b;
    }
    if (cur < w.a1) line.solid.push([cur, w.a1]);
    lines.set(key, line);
  }
  const merge = (iv: [number, number][]) => {
    const out: [number, number][] = [];
    for (const [a, b] of [...iv].sort((p, q) => p[0] - q[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
  };
  return Object.fromEntries(
    [...lines.entries()].sort().map(([k, v]) => [k, { solid: merge(v.solid), glass: merge(v.glass), lintel: v.lintel.map(([a, b, y]): [number, number, number | undefined] => [Math.round(a * 10) / 10, Math.round(b * 10) / 10, y]).sort((p, q) => p[0] - q[0]) }]),
  );
}

const signs = (l: VenueLayout) => l.items.filter((i) => i.t === "sign").map((i) => JSON.stringify(i)).sort();
const notSigns = (l: VenueLayout) => l.items.filter((i) => i.t !== "sign");
const doorKey = (l: VenueLayout) => l.doors.map((d) => JSON.stringify(d)).sort();

describe("round trip: automatic layout -> plan -> layout", () => {
  it.each(Object.entries(LAYOUT_FIXTURES))("%s is the same building", (_name, rooms) => {
    const auto = generateLayout(rooms, { eventName: "Round Trip 2027" });
    const plan = planFromLayout(auto);
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(planIssues(rooms, plan)).toEqual([]);

    const { layout, issues } = layoutFromPlan(rooms, plan, { eventName: "Round Trip 2027" });
    expect(issues).toEqual([]);
    expect(layout.bounds).toEqual(auto.bounds);
    expect(layout.zones).toEqual(auto.zones);
    expect(doorKey(layout)).toEqual(doorKey(auto));
    expect(notSigns(layout)).toEqual(notSigns(auto));
    expect(signs(layout)).toEqual(signs(auto));
    expect(layout.people).toEqual(auto.people);
    expect(layout.hotspots).toEqual(auto.hotspots);
    expect(layout.routes).toEqual(auto.routes);
    expect(wallMap(layout.walls)).toEqual(wallMap(auto.walls));
    expect(checkLayout(layout).issues).toEqual([]);
  });
});

const room = (id: string, kind: VenueRoom["kind"], capacity: number): VenueRoom => ({ id, name: id.replace(/-/g, " "), kind, capacity });

/** A plan the template cannot make: an L of walkways, rooms on three sides, a door in a north wall, the entrance in the west wall. */
function lPlan(): { rooms: VenueRoom[]; plan: VenuePlan } {
  const rooms = [room("foyer", "foyer", 200), room("hall-a", "hall", 80), room("expo", "exhibition", 150), room("lounge", "lounge", 40)];
  const plan: VenuePlan = {
    v: 1,
    rooms: [
      { id: "foyer", rect: [-20, 0, 0, 16], door: { wall: "e", at: 8, width: 5 } },
      { id: "hall-a", rect: [0, -24, 22, -6], door: { wall: "s", at: 11, width: 2.6 } },
      { id: "expo", rect: [6, 0, 34, 24], door: { wall: "n", at: 20, width: 4 } },
      { id: "lounge", rect: [22, -24, 34, -6], door: { wall: "s", at: 28, width: 2.6 } },
    ],
    corridors: [
      { id: "walk-1", name: "Walkway", rect: [0, -6, 34, 0] },
      { id: "walk-2", name: "Link", rect: [0, 0, 6, 16] },
    ],
    entrance: { wall: "w", at: 8, width: 6 },
    fixtures: [],
  };
  return { rooms, plan };
}

describe("a drawn plan the template could never make", () => {
  it("builds, is walkable, and has no wall between the two walkways", () => {
    const { rooms, plan } = lPlan();
    expect(planIssues(rooms, plan)).toEqual([]);
    const { layout, issues } = layoutFromPlan(rooms, plan, { eventName: "Drawn" });
    expect(issues).toEqual([]);
    expect(checkLayout(layout).issues).toEqual([]);
    // Walkway and link meet along z = 0 from x 0 to 6: one open space, no wall there.
    const z0 = layout.walls.filter((w) => w.axis === "x" && w.k === 0);
    expect(z0.some((w) => w.a0 < 5 && w.a1 > 1)).toBe(false);
    // The expo's door is in its north wall, so its stands face north.
    const stands = layout.items.filter((i) => i.t === "stand");
    expect(stands.length).toBeGreaterThan(0);
    expect(layout.zones.find((z) => z.id === "expo")!.spawn[2]).toBe(0);
    // The entrance is glass in the foyer's west wall.
    expect(layout.walls.some((w) => w.axis === "z" && w.k === -20 && w.opens.some((o) => o.glass))).toBe(true);
  });

  it("names a door that opens onto the outside", () => {
    const { rooms, plan } = lPlan();
    plan.rooms[3].door = { wall: "e", at: -15, width: 2.6 };
    const { issues } = layoutFromPlan(rooms, plan, { eventName: "x" });
    expect(issues.join(" ")).toMatch(/lounge: its door opens onto the outside/);
  });

  it("names an entrance that opens into another room", () => {
    const { rooms, plan } = lPlan();
    plan.entrance = { wall: "e", at: 8, width: 3 };
    const { issues } = layoutFromPlan(rooms, plan, { eventName: "x" });
    expect(issues.join(" ")).toMatch(/entrance opens into another room/);
  });
});

describe("planIssues", () => {
  it("names unplaced, unknown, overlapping and ill-fitting rooms", () => {
    const { rooms, plan } = lPlan();
    const bad: VenuePlan = {
      ...plan,
      rooms: [
        ...plan.rooms.filter((p) => p.id !== "lounge"),
        { id: "ghost", rect: [40, 0, 50, 10], door: { wall: "n", at: 45, width: 2.6 } },
      ],
    };
    bad.rooms[1] = { ...bad.rooms[1], rect: [0, -24, 25, -6], door: { wall: "s", at: 24.5, width: 2.6 } };
    const issues = planIssues([...rooms], bad).join(" | ");
    expect(issues).toMatch(/lounge is not on the plan yet/);
    expect(issues).toMatch(/not on the room list \(ghost\)/);
    expect(issues).toMatch(/hall a: its door does not fit on its wall/);
  });

  it("names overlaps", () => {
    const { rooms, plan } = lPlan();
    plan.rooms[3].rect = [20, -24, 34, -6];
    expect(planIssues(rooms, plan).join(" ")).toMatch(/hall a and lounge overlap/);
  });
});

describe("readVenuePlan", () => {
  it("reads a saved plan, and treats anything malformed as automatic", () => {
    const { plan } = lPlan();
    expect(readVenuePlan({ venue: { plan: { plan, updatedAt: 7, updatedBy: "u1" } } })).toEqual({ plan, updatedAt: 7, updatedBy: "u1" });
    expect(readVenuePlan({ venue: { plan: { plan: { ...plan, v: 2 } } } })).toBeNull();
    expect(readVenuePlan({})).toBeNull();
  });
});

describe("fixtures (stairs, lifts, toilets, exits, pillars, catering)", () => {
  it("a plan saved before fixtures existed still reads, with none", () => {
    const { plan } = lPlan();
    const { fixtures: _none, ...old } = plan;
    void _none;
    expect(planSchema.parse(old).fixtures).toEqual([]);
  });

  it("refuses a fixture outside every room, overlapping another, or with a clashing id", () => {
    const { rooms, plan } = lPlan();
    const issues = planIssues(rooms, {
      ...plan,
      fixtures: [
        { id: "p1", kind: "pillar", name: "", rect: [100, 100, 101, 101], dir: "n" },
        { id: "p2", kind: "pillar", name: "Column A", rect: [-10, 5, -9, 6], dir: "n" },
        { id: "p3", kind: "pillar", name: "Column B", rect: [-9.5, 5.5, -8.5, 6.5], dir: "n" },
        { id: "expo", kind: "lift", name: "", rect: [10, 10, 12, 12], dir: "n" },
      ],
    });
    expect(issues).toEqual(
      expect.arrayContaining(["Pillar is not inside a room or walkway", "Column A and Column B overlap", "Lift shares its id with another part of the plan"]),
    );
  });

  it("drops the furniture a solid fixture stands on and numbers the stands again from 1", () => {
    const { rooms, plan } = lPlan();
    const before = layoutFromPlan(rooms, plan, { eventName: "" }).layout;
    const stands = before.items.filter((it): it is Extract<LayoutItem, { t: "stand" }> => it.t === "stand");
    const first = stands[0].foot as { x0: number; z0: number; x1: number; z1: number };
    // A pillar right on stand 1.
    const withPillar = { ...plan, fixtures: [{ id: "p1", kind: "pillar" as const, name: "", rect: [first.x0 + 0.5, first.z0 + 0.5, first.x0 + 1.3, first.z0 + 1.3] as Rect, dir: "n" as const }] };
    const after = layoutFromPlan(rooms, withPillar, { eventName: "" }).layout;
    const left = after.items.filter((it): it is Extract<LayoutItem, { t: "stand" }> => it.t === "stand");
    expect(left.length).toBe(stands.length - 1);
    expect(left.map((s) => s.n)).toEqual(left.map((_, i) => i + 1));
    expect(left.map((s) => s.label)).toEqual(left.map((_, i) => `Stand ${i + 1}`));
    const standSpots = after.hotspots.filter((h) => h.kind === "stand").map((h) => h.id).sort();
    expect(standSpots).toEqual(left.map((s) => `stand-${s.n}`).sort());
    expect(after.items.filter((it) => it.t === "fixture")).toHaveLength(1);
    expect(checkLayout(after).issues).toEqual([]);
  });

  it("a fixture that blocks the only way into a room is refused by the walk check, with the room named", () => {
    const { rooms, plan } = lPlan();
    // The lounge's door is on its south wall at x 28; a pillar the width of the walkway in front of it.
    const blocked = { ...plan, fixtures: [{ id: "wall-of-pillar", kind: "pillar" as const, name: "", rect: [24, -6, 34, 0] as Rect, dir: "n" as const }] };
    const issues = checkLayout(layoutFromPlan(rooms, blocked, { eventName: "" }).layout).issues;
    expect(issues.join(" ")).toMatch(/lounge/i);
  });
});
