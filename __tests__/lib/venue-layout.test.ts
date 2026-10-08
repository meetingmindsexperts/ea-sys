/**
 * The venue generator and its walkability check (docs/EVENT_BLUEPRINT_PLAN.md,
 * D10, phase 6 step 2). Every room list the rules accept must become a
 * building a person can walk around; the check must catch one they cannot.
 * The two regressions pinned below were found by a 3,500-case fuzz before the
 * first commit: workshop tables with no aisle between them, and the foyer
 * directory landing on the entrance line.
 */
import { describe, it, expect } from "vitest";
import { ROOM_KINDS, ROOM_KIND_INFO, TEMPLATES, TEMPLATE_KEYS, roomsSchema, type VenueRoom } from "@/lib/venue/rooms";
import { generateLayout, type VenueLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";

const gen = (rooms: VenueRoom[]) => generateLayout(rooms, { eventName: "Test Congress" });

/** Rooms whose furniture does not cover their people: seats (up to 420 drawn), workshop seats, stands, boards. */
function shortOf(l: VenueLayout): string[] {
  const out: string[] = [];
  for (const z of l.zones) {
    const items = l.items.filter((i) => i.zone === z.id);
    const seats = items.reduce((n, i) => n + (i.t === "row" ? i.n : i.t === "round" ? i.chairs : 0), 0);
    const count = (t: string) => items.filter((i) => i.t === t).length;
    const wanted = (per: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(z.capacity / per)));
    if ((z.kind === "hall" || z.kind === "plenary") && seats < Math.min(z.capacity, 420)) out.push(`${z.name}: ${seats} seats`);
    if (z.kind === "workshop" && seats < z.capacity) out.push(`${z.name}: ${seats} seats`);
    if (z.kind === "exhibition" && count("stand") < wanted(25, 4, 24)) out.push(`${z.name}: ${count("stand")} stands`);
    if (z.kind === "posters" && count("poster") < wanted(5, 6, 40)) out.push(`${z.name}: ${count("poster")} boards`);
  }
  return out;
}
const area = (r: [number, number, number, number]) => (r[2] - r[0]) * (r[3] - r[1]);

describe("generateLayout", () => {
  it.each(TEMPLATE_KEYS)("%s: walkable, every room holds its people, and the rooms tile the building exactly", (key) => {
    const layout = gen(TEMPLATES[key].rooms);
    expect(checkLayout(layout)).toMatchObject({ ok: true, issues: [] });
    expect(shortOf(layout)).toEqual([]);
    const zones = layout.zones.reduce((n, z) => n + area(z.rect), 0);
    expect(zones).toBeCloseTo(area(layout.bounds), 1);
  });

  it("is deterministic: the same rooms always make the same building", () => {
    expect(gen(TEMPLATES.congress.rooms)).toEqual(gen(TEMPLATES.congress.rooms));
  });

  it("lays out the plan D10 describes: foyer south, plenary north, a door from the corridor into every room", () => {
    const l = gen(TEMPLATES.congress.rooms);
    const foyer = l.zones.find((z) => z.kind === "foyer")!;
    const plenary = l.zones.find((z) => z.kind === "plenary")!;
    expect(foyer.rect[3]).toBe(l.bounds[3]);
    expect(plenary.rect[1]).toBe(l.bounds[1]);
    for (const z of l.zones.filter((zn) => !["foyer", "corridor"].includes(zn.kind))) {
      expect(l.doors.some((d) => d.between.includes(z.id) && d.between.includes("corridor"))).toBe(true);
    }
    expect(l.doors.every((d) => d.width >= 1.6)).toBe(true);
  });

  it("never draws more seats than a room holds, and at most 420 in one room", () => {
    const rooms = TEMPLATES.congress.rooms.map((r) => (r.kind === "plenary" ? { ...r, capacity: 2500 } : r));
    const l = gen(rooms);
    for (const z of l.zones) {
      const seats = l.items.filter((it) => it.zone === z.id && it.t === "row").reduce((n, it) => n + (it.t === "row" ? it.n : 0), 0);
      expect(seats).toBeLessThanOrEqual(Math.min(z.capacity, 420));
    }
    expect(checkLayout(l).ok).toBe(true);
  });

  it("names screens, hotspots and doors so the venue's other code can find them", () => {
    const l = gen(TEMPLATES.congress.rooms);
    expect(l.items.some((it) => it.t === "screen" && it.id === "plenary-main")).toBe(true);
    expect(l.hotspots.map((h) => h.id)).toEqual(expect.arrayContaining(["Registration", "Information", "plenary-screen", "hall-a-screen", "stand-1"]));
  });

  it("regression: workshop tables leave a walkable aisle between them", () => {
    const rooms: VenueRoom[] = [
      { id: "foyer", name: "Foyer", kind: "foyer", capacity: 300 },
      { id: "workshop", name: "Workshop", kind: "workshop", capacity: 200 },
    ];
    const l = gen(rooms);
    expect(checkLayout(l).ok).toBe(true);
    const rounds = l.items.filter((it) => it.t === "round");
    for (const a of rounds) for (const b of rounds) if (a !== b && a.t === "round" && b.t === "round") expect(Math.hypot(a.cx - b.cx, a.cz - b.cz)).toBeGreaterThan(4.99);
  });

  it("regression: the foyer directory stays off the entrance line when the corridor runs along an edge", () => {
    const rooms = ([["foyer", 1581], ["hall", 118], ["hall", 800], ["hall", 757]] as const).map(([kind, capacity], i) => ({ id: `${kind}-${i}`, name: `${kind} ${i}`, kind, capacity }));
    expect(checkLayout(gen(rooms))).toMatchObject({ ok: true });
  });

  it("every valid room list in a seeded random batch is walkable", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let cases = 0;
    while (cases < 120) {
      const rooms: VenueRoom[] = [];
      for (const k of ROOM_KINDS) {
        const info = ROOM_KIND_INFO[k];
        const count = k === "foyer" ? 1 : Math.floor(rnd() * (info.max + 1));
        for (let i = 0; i < count; i++) rooms.push({ id: `${k}-${i}`, name: `${k} ${i}`, kind: k, capacity: Math.round(info.capacity.min + rnd() * (info.capacity.max - info.capacity.min)) });
      }
      if (!roomsSchema.safeParse(rooms).success) continue;
      cases++;
      const layout = gen(rooms);
      const label = JSON.stringify(rooms.map((r) => [r.kind, r.capacity]));
      expect(checkLayout(layout).issues, label).toEqual([]);
      expect(shortOf(layout), label).toEqual([]);
    }
  });
});

describe("checkLayout", () => {
  const base = (): VenueLayout => gen(TEMPLATES.summit.rooms);

  it("refuses a building where furniture blocks the way into the corridor", () => {
    const l = base();
    const d = l.doors.find((x) => x.between[1] === "corridor")!;
    l.items.push({ t: "plant", zone: "corridor", solid: true, cx: d.x, cz: d.z - 1, s: 1, foot: { x0: d.x - d.width, z0: d.z - 2, x1: d.x + d.width, z1: d.z - 0.2 } } as never);
    const res = checkLayout(l);
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(expect.arrayContaining(["Main Corridor cannot be reached from the entrance"]));
  });

  it("refuses overlapping rooms and a blocked entrance", () => {
    const l = base();
    l.zones[2] = { ...l.zones[2], rect: [l.zones[0].rect[0], l.zones[0].rect[1] - 5, l.zones[0].rect[2], l.zones[0].rect[1] + 2] };
    const foyer = l.zones[0];
    l.items.push({ t: "plant", zone: foyer.id, solid: true, cx: foyer.spawn[0], cz: foyer.spawn[1], s: 1, foot: { cx: foyer.spawn[0], cz: foyer.spawn[1], r: 1 } } as never);
    const res = checkLayout(l);
    expect(res.issues.some((m) => m.includes("overlap"))).toBe(true);
    expect(res.issues).toContain("The entrance is blocked");
  });
});
