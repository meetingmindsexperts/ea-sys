/**
 * A room's real stage and screen (rooms.ts `stage` / `screen`; the Al Wasl Ballroom plan: a 10.98 x 3.66 m stage,
 * a 10 x 3 m LED screen): the layout draws them at their size, kept inside the room, seats start from the real
 * stage, and the room's "does it fit" follows. Without them nothing changes.
 */
import { describe, it, expect } from "vitest";
import { fits, generateLayout, type LayoutItem } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { LAYOUT_FIXTURES } from "@/lib/venue/layout-fixtures";
import { roomSizes, roomsSchema, TEMPLATES, type VenueRoom } from "@/lib/venue/rooms";

const extent = (it: LayoutItem) => {
  const f = it.foot as { x0: number; z0: number; x1: number; z1: number };
  return { w: +(f.x1 - f.x0).toFixed(2), d: +(f.z1 - f.z0).toFixed(2) };
};

describe("the Al Wasl Ballroom's sizes in the layout", () => {
  const layout = generateLayout(LAYOUT_FIXTURES.setups, { eventName: "x" });
  const items = layout.items.filter((it) => it.zone === "plenary-0");

  it("the stage is 10.98 m by 3.66 m and the screen 10 m by 3 m, above the stage", () => {
    const stage = items.find((it) => it.t === "stage")!;
    expect(extent(stage)).toEqual({ w: 10.98, d: 3.66 });
    const screen = items.find((it): it is Extract<LayoutItem, { t: "screen" }> => it.t === "screen")!;
    expect(screen.w).toBe(10);
    expect(screen.hgt).toBe(3);
    // Its bottom half a metre above the 0.9 m plenary stage.
    expect(screen.y - screen.hgt / 2).toBeCloseTo(1.4, 5);
  });

  it("the first classroom table starts 2.5 m from the real stage's front", () => {
    const stage = items.find((it) => it.t === "stage")!.foot as { z0: number; z1: number };
    const tables = items.filter((it) => it.t === "longTable").map((it) => it.foot as { z0: number; z1: number });
    // The plenary's door is in the south: the stage is at the north (low z), seats run south from it.
    // A table's footprint starts at its front edge, the side facing the stage.
    const firstTableFront = Math.min(...tables.map((t) => t.z0));
    expect(+(firstTableFront - stage.z1).toFixed(2)).toBe(2.5);
  });

  it("is still walkable", () => {
    expect(checkLayout(layout).ok).toBe(true);
  });
});

describe("sizes are kept inside the room", () => {
  const hall = (stage: VenueRoom["stage"], screen?: VenueRoom["screen"]): VenueRoom[] => [
    { id: "foyer", name: "Foyer", kind: "foyer", capacity: 100 },
    { id: "hall", name: "Hall", kind: "hall", capacity: 60, stage, ...(screen && { screen }) },
  ];

  it("a stage wider than the room stops half a metre from each wall; a deep one at two fifths of the room", () => {
    const l = generateLayout(hall({ w: 40, d: 15 }, { w: 30, h: 12 }), { eventName: "x" });
    const zone = l.zones.find((z) => z.id === "hall")!;
    const across = zone.rect[3] - zone.rect[1];
    const deep = zone.rect[2] - zone.rect[0];
    const stage = l.items.find((it) => it.zone === "hall" && it.t === "stage")!.foot as { x0: number; z0: number; x1: number; z1: number };
    expect(stage.z1 - stage.z0).toBeCloseTo(across - 1, 1);
    expect(stage.x1 - stage.x0).toBeCloseTo(deep * 0.4, 1);
    const screen = l.items.find((it): it is Extract<LayoutItem, { t: "screen" }> => it.zone === "hall" && it.t === "screen")!;
    expect(screen.w).toBeLessThanOrEqual(across - 1);
    expect(screen.y + screen.hgt / 2).toBeLessThanOrEqual(zone.ceil - 0.3 + 1e-9);
  });
});

describe("what a room must measure follows its stage", () => {
  it("a deep real stage needs a deeper room than the venue's own", () => {
    const room: VenueRoom = { id: "h", name: "H", kind: "hall", capacity: 120 };
    expect(fits(room, 18, 14)).toBe(true);
    expect(fits({ ...room, stage: { w: 12, d: 5.5 } }, 18, 14)).toBe(false);
  });

  it("a boardroom ignores a stage size, and keeps it for when the setup changes back", () => {
    const room: VenueRoom = { id: "h", name: "H", kind: "workshop", capacity: 20, setup: "boardroom", stage: { w: 10, d: 3 } };
    expect(roomSizes(room).stage).toBeUndefined();
    expect(roomSizes({ ...room, setup: "theatre" }).stage).toEqual([10, 3]);
  });
});

describe("what the room list accepts", () => {
  const base = TEMPLATES.meeting.rooms;
  const patch = (kind: VenueRoom["kind"], p: Partial<VenueRoom>) => base.map((r) => (r.kind === kind ? { ...r, ...p } : r));

  it("takes a stage and a screen on a seated room", () => {
    expect(roomsSchema.safeParse(patch("plenary", { stage: { w: 10.98, d: 3.66 }, screen: { w: 10, h: 3 } })).success).toBe(true);
  });

  it("refuses them on a room people do not sit in, and sizes no stage or screen has", () => {
    const lounge = roomsSchema.safeParse(patch("lounge", { screen: { w: 4, h: 2 } }));
    expect(lounge.success).toBe(false);
    expect(JSON.stringify(lounge.error?.issues)).toMatch(/only a room people sit in has a stage or a screen/);
    const thin = roomsSchema.safeParse(patch("plenary", { stage: { w: 1.5, d: 3 } }));
    expect(thin.success).toBe(false);
    // Named, so several rooms' mistakes can be told apart (review of 05371679).
    expect(JSON.stringify(thin.error?.issues)).toMatch(/Meeting Room: a stage is 2 to 40 m wide/);
    expect(roomsSchema.safeParse(patch("plenary", { stage: { w: 4, d: 0.5 } })).success).toBe(false);
    expect(roomsSchema.safeParse(patch("plenary", { screen: { w: 10, h: 20 } })).success).toBe(false);
    expect(roomsSchema.safeParse(patch("plenary", { screen: { w: Number.NaN, h: 2 } })).success).toBe(false);
  });
});

describe("review of 05371679", () => {
  const one = (stage: VenueRoom["stage"], screen?: VenueRoom["screen"]): VenueRoom[] => [
    { id: "foyer", name: "Foyer", kind: "foyer", capacity: 100 },
    { id: "hall", name: "Hall", kind: "hall", capacity: 60, stage, ...(screen && { screen }) },
  ];

  it("on the smallest stage the lectern and the speaker stay on it", () => {
    const l = generateLayout(one({ w: 2, d: 1 }), { eventName: "x" });
    const stage = l.items.find((it) => it.zone === "hall" && it.t === "stage")!.foot as { x0: number; z0: number; x1: number; z1: number };
    const lectern = l.items.find((it) => it.zone === "hall" && it.t === "lectern")!.foot as { x0: number; z0: number; x1: number; z1: number };
    const speaker = l.people.find((p) => p.role === "speaker" && p.x >= stage.x0 - 5 && p.x <= stage.x1 + 5 && p.z >= stage.z0 - 5 && p.z <= stage.z1 + 5)!;
    for (const [lo, hi, a, b] of [[stage.x0, stage.x1, lectern.x0, lectern.x1], [stage.z0, stage.z1, lectern.z0, lectern.z1]]) {
      expect(a).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(b).toBeLessThanOrEqual(hi + 1e-9);
    }
    expect(speaker.x).toBeGreaterThanOrEqual(stage.x0);
    expect(speaker.x).toBeLessThanOrEqual(stage.x1);
    expect(speaker.z).toBeGreaterThanOrEqual(stage.z0);
    expect(speaker.z).toBeLessThanOrEqual(stage.z1);
  });

  it("a 2.3 m screen is drawn 2.3 m high, not 2 cm short", () => {
    const l = generateLayout(one(undefined, { w: 6, h: 2.3 }), { eventName: "x" });
    const screen = l.items.find((it): it is Extract<LayoutItem, { t: "screen" }> => it.zone === "hall" && it.t === "screen")!;
    expect(screen.hgt).toBe(2.3);
  });
});
