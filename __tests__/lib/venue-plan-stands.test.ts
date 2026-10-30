/**
 * Stands placed on the plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, section 10,
 * phase A). The promises: placing them yourself starts from exactly what the
 * venue showed; a stand's number is a label that can change at the last minute
 * without moving its sponsor or its visits; stands stand shoulder to shoulder;
 * and every reader takes the sponsor from the one rule in stands.ts.
 */
import { describe, it, expect } from "vitest";
import { generateLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { LAYOUT_FIXTURES, PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { planFromLayout, planIssues, planSchema, isInternal, fixtureLabel, type PlanFixture, type VenuePlan } from "@/lib/venue/plan";
import { buildVenueLayout, layoutFromPlan } from "@/lib/venue/plan-layout";
import { addStand, automaticStands, nextStandNumber, placeStandsYourself, renumberStands, setFixture } from "@/lib/venue/plan-edit";
import { layoutStands, sponsorsWithStands, standNumber, standSponsor } from "@/lib/venue/stands";

const rooms = LAYOUT_FIXTURES.congress;
const auto = () => planFromLayout(generateLayout(rooms, { eventName: "" }));
const sponsors = Array.from({ length: 30 }, (_, i) => ({ id: `sp${i + 1}`, name: `Sponsor ${i + 1}` }));
const built = (plan: VenuePlan) => {
  const b = buildVenueLayout(rooms, plan, { eventName: "" });
  expect(b.planIssues).toEqual([]);
  expect(b.mode).toBe("drawn");
  return b.layout;
};
const stands = (plan: VenuePlan) => plan.fixtures.filter((f) => f.kind === "stand" || f.kind === "table");

describe("placing the stands yourself", () => {
  it("starts from exactly the stands, numbers and sponsors the venue showed", () => {
    const before = layoutStands(generateLayout(rooms, { eventName: "" }));
    expect(before.length).toBeGreaterThan(4);
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    expect(plan.standsPlaced).toBe(true);
    const after = layoutStands(built(plan));
    expect(after).toHaveLength(before.length);
    const key = (s: (typeof after)[number]) => [standNumber(s), standSponsor(s, sponsors)?.name ?? null, s.foot];
    expect(after.map(key)).toEqual(before.map(key));
    // Every placed stand can still be reached and visited.
    expect(checkLayout(built(plan)).ok).toBe(true);
  });

  it("is a no-op the second time, and going back to automatic gives the automatic stands again", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    expect(placeStandsYourself(plan, rooms, sponsors)).toBe(plan);
    const back = automaticStands(plan);
    expect(back.standsPlaced).toBeUndefined();
    expect(stands(back)).toEqual([]);
    expect(layoutStands(built(back))).toEqual(layoutStands(generateLayout(rooms, { eventName: "" })));
  });

  it("saves through the schema with its numbers, sponsors and notes", () => {
    const plan = setFixture(placeStandsYourself(auto(), rooms, sponsors), "stand-1", { note: "Power 2 x 13 A", number: "A3" });
    const parsed = planSchema.parse(plan);
    expect(parsed.standsPlaced).toBe(true);
    expect(parsed.fixtures.find((f) => f.id === "stand-1")).toMatchObject({ number: "A3", sponsorId: "sp1", note: "Power 2 x 13 A" });
  });

  it("refuses a stand number that is not a short label", () => {
    const plan = setFixture(placeStandsYourself(auto(), rooms, sponsors), "stand-1", { number: "Stand <b>7</b>" });
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
});

describe("a last-minute change", () => {
  it("renumbering moves neither the sponsor nor the visit point", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    const spot = (l: ReturnType<typeof built>, id: string) => l.hotspots.find((h) => h.id === `stand-${id}`);
    const was = built(plan);
    const swapped = setFixture(setFixture(plan, "stand-1", { number: "99" }), "stand-2", { number: "1" });
    const now = built(swapped);
    expect(spot(now, "stand-1")).toEqual({ ...spot(was, "stand-1"), prompt: "Visit Stand 99", title: "Stand 99" });
    const one = layoutStands(now).find((s) => s.key === "stand-1")!;
    expect(standSponsor(one, sponsors)?.id).toBe("sp1");
  });

  it("a sponsor who cancels leaves the stand Available, and another can take it", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    const s1 = () => layoutStands(built(cancelled)).find((s) => s.key === "stand-1")!;
    let cancelled = setFixture(plan, "stand-1", { sponsorId: null });
    expect(standSponsor(s1(), sponsors)).toBeNull();
    cancelled = setFixture(cancelled, "stand-1", { sponsorId: "sp9" });
    expect(standSponsor(s1(), sponsors)?.name).toBe("Sponsor 9");
  });

  it("a sponsor deleted since reads as Available, never as an error", () => {
    const plan = setFixture(placeStandsYourself(auto(), rooms, sponsors), "stand-1", { sponsorId: "gone" });
    expect(standSponsor(layoutStands(built(plan)).find((s) => s.key === "stand-1")!, sponsors)).toBeNull();
  });
});

describe("the plan's checks", () => {
  const placed = () => placeStandsYourself(auto(), rooms, sponsors);

  it("refuses two stands with one number, and a stand with none", () => {
    expect(planIssues(rooms, setFixture(placed(), "stand-2", { number: "1" }))).toContain("2 stands share the number 1. Give each its own, or click Renumber stands.");
    expect(planIssues(rooms, setFixture(placed(), "stand-2", { number: undefined }))).toContain("A exhibition stand has no number. Give it one.");
  });

  it("refuses a stand whose open side faces a wall", () => {
    const plan = placed();
    const s = plan.fixtures.find((f) => f.id === "stand-1")!;
    const room = plan.rooms.find((r) => r.rect[0] <= s.rect[0] && r.rect[2] >= s.rect[2] && r.rect[1] <= s.rect[1] && r.rect[3] >= s.rect[3])!;
    // Pushed against the room's north wall and turned to face it.
    const against = { ...s, rect: [s.rect[0], room.rect[1], s.rect[2], room.rect[1] + 3] as PlanFixture["rect"], dir: "n" as const };
    const issues = planIssues(rooms, { ...plan, fixtures: plan.fixtures.map((f) => (f.id === s.id ? against : f)) });
    expect(issues).toContain(`${fixtureLabel(s)} faces a wall. Turn it so its arrow points into the room.`);
  });
});

describe("stands of any size, anywhere", () => {
  it("stands two shoulder to shoulder, with no gap, and keeps both", () => {
    let plan = placeStandsYourself(auto(), rooms, sponsors);
    plan = { ...plan, fixtures: plan.fixtures.filter((f) => f.kind !== "stand") };
    const hall = plan.rooms[0];
    const corridor = plan.corridors[0];
    const host = corridor.rect;
    const [x0, z0] = [host[0], host[1] + 4];
    const a: PlanFixture = { id: "stand-a", kind: "stand", name: "", rect: [x0, z0, x0 + 3, z0 + 3], dir: "e", number: "01", sponsorId: "sp1" };
    const b: PlanFixture = { ...a, id: "stand-b", rect: [x0, z0 + 3, x0 + 3, z0 + 6], number: "02", sponsorId: "sp2" };
    plan = { ...plan, fixtures: [...plan.fixtures, a, b] };
    expect(hall).toBeTruthy();
    const l = built(plan);
    expect(layoutStands(l).map((s) => s.key)).toEqual(["stand-a", "stand-b"]);
    expect(l.hotspots.filter((h) => h.kind === "stand").map((h) => h.id)).toEqual(["stand-stand-a", "stand-stand-b"]);
    expect(checkLayout(l).ok).toBe(true);
  });

  it("a table is a numbered stand with its exhibitor behind it", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    const foyer = plan.rooms.find((r) => rooms.find((x) => x.id === r.id)?.kind === "foyer")!;
    const added = addStand(plan, "table", [2, 1], foyer.rect)!;
    const t = added.plan.fixtures.find((f) => f.id === added.id)!;
    expect(t).toMatchObject({ kind: "table", number: nextStandNumber(plan), sponsorId: null });
    const l = built(added.plan);
    const item = layoutStands(l).find((s) => s.key === added.id)!;
    expect(item.table).toBe(true);
    expect(standNumber(item)).toBe(t.number);
    expect(l.hotspots.some((h) => h.id === `stand-${added.id}`)).toBe(true);
  });

  it("keeps placed stands' numbers and visit points on Level 1, while automatic ones number on through the floors", () => {
    const { rooms: r2rooms, plan: two } = PLAN_FIXTURES["drawn-two-floors"];
    // A stand in Level 1's corridor, west wall, open to the east.
    const up: PlanFixture = { id: "stand-up", kind: "stand", name: "", floor: "level-1", rect: [1, -18, 4, -15], dir: "e", number: "L1-01", sponsorId: "sp2" };
    const plan: VenuePlan = { ...two, fixtures: [...two.fixtures, up], standsPlaced: true };
    expect(planIssues(r2rooms, plan)).toEqual([]);
    const l = layoutFromPlan(r2rooms, plan, { eventName: "" });
    expect(l.issues).toEqual([]);
    const s = layoutStands(l.layout);
    expect(s.map((x) => [x.key, standNumber(x)])).toEqual([["stand-up", "L1-01"]]);
    expect(l.layout.hotspots.some((h) => h.id === "stand-stand-up" && h.title === "Stand L1-01")).toBe(true);
    expect(checkLayout(l.layout).ok).toBe(true);
  });
});

describe("numbers", () => {
  it("the next number follows the plan's own style", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    expect(nextStandNumber(plan)).toBe(String(stands(plan).length + 1));
    expect(nextStandNumber(renumberStands(plan))).toBe(String(stands(plan).length + 1).padStart(2, "0"));
    expect(nextStandNumber({ ...plan, fixtures: [], otherNumbers: ["07"] })).toBe("08");
  });

  it("renumbers in reading order, row by row from the north, two digits from ten stands", () => {
    const plan = renumberStands(placeStandsYourself(auto(), rooms, sponsors));
    const list = stands(plan).map((f) => ({ n: f.number!, x: (f.rect[0] + f.rect[2]) / 2, z: (f.rect[1] + f.rect[3]) / 2 }));
    const sorted = [...list].sort((a, b) => a.n.localeCompare(b.n));
    expect(sorted[0].n).toBe(list.length >= 10 ? "01" : "1");
    for (let i = 1; i < sorted.length; i++) {
      const [p, q] = [sorted[i - 1], sorted[i]];
      expect(q.z - p.z > 1.5 || (Math.abs(q.z - p.z) <= 1.5 && q.x > p.x) || q.z > p.z).toBe(true);
    }
  });
});

describe("the one sponsor rule", () => {
  it("an automatic stand takes the nth sponsor; a placed one its own; each sponsor named once", () => {
    const a = layoutStands(generateLayout(rooms, { eventName: "" }));
    expect(standSponsor(a[2], sponsors)?.id).toBe("sp3");
    const placed = layoutStands(built(setFixture(setFixture(placeStandsYourself(auto(), rooms, sponsors), "stand-1", { sponsorId: "sp5" }), "stand-2", { sponsorId: "sp5" })));
    expect(sponsorsWithStands(placed, sponsors).filter((s) => s.id === "sp5")).toHaveLength(1);
  });
});

describe("new fixtures", () => {
  it("an AV console is internal unless the team says otherwise; a stage is not", () => {
    expect(isInternal({ kind: "av-console" })).toBe(true);
    expect(isInternal({ kind: "av-console", internal: false })).toBe(false);
    expect(isInternal({ kind: "stage" })).toBe(false);
    expect(isInternal({ kind: "stand", internal: true })).toBe(true);
  });
});

describe("a plan written without the switch", () => {
  it("any stand of its own turns the automatic grid off, so the two never mix", () => {
    const plan = placeStandsYourself(auto(), rooms, sponsors);
    // Stand 1 taken away: an automatic stand must not come back in its place.
    const unflagged = { ...plan, standsPlaced: undefined, fixtures: plan.fixtures.filter((f) => f.id !== "stand-1") };
    expect(layoutStands(layoutFromPlan(rooms, unflagged, { eventName: "" }).layout).every((s) => s.key)).toBe(true);
  });
});

describe("the vendor's walk fixture", () => {
  it("the placed-stands plan the 3D venue's own checks walk is valid, builds and is walkable", () => {
    const { rooms: r, plan } = PLAN_FIXTURES["drawn-placed-stands"];
    expect(planIssues(r, plan)).toEqual([]);
    const l = layoutFromPlan(r, plan, { eventName: "" });
    expect(l.issues).toEqual([]);
    expect(checkLayout(l.layout).issues).toEqual([]);
    expect(new Set(plan.fixtures.map((f) => f.kind))).toEqual(new Set(["stand", "table", "stage", "av-console", "program-wall"]));
    expect(plan.fixtures.some((f) => f.kind === "stand" && f.sponsorId === null)).toBe(true);
  });
});
