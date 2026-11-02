/**
 * Room setups (rooms.ts ROOM_SETUPS; the Al Wasl Ballroom plan, Oct 30, 2026): a seated room laid out as a
 * hotel's banqueting team would set it, seating exactly its people, saved only for the rooms a setup applies
 * to, and absent unless chosen, so a venue saved before setups existed lays out exactly as it did.
 */
import { describe, it, expect } from "vitest";
import { fits, generateLayout, type LayoutItem } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { LAYOUT_FIXTURES } from "@/lib/venue/layout-fixtures";
import { roomsFromBlueprint, type BlueprintSpace } from "@/lib/venue/blueprint-rooms";
import { roomsSchema, setupOf, TEMPLATES, type VenueRoom } from "@/lib/venue/rooms";

const layout = generateLayout(LAYOUT_FIXTURES.setups, { eventName: "Setups" });
const itemsIn = (zone: string) => layout.items.filter((it) => it.zone === zone);
const seatsIn = (zone: string) =>
  itemsIn(zone).reduce((n, it: LayoutItem) => {
    if (it.t === "row") return n + it.n;
    if (it.t === "longTable") return n + it.n * (it.both ? 2 : 1);
    if (it.t === "round") return n + it.chairs;
    return n;
  }, 0);

describe("each setup seats the room's people", () => {
  it.each(LAYOUT_FIXTURES.setups.filter((r) => setupOf(r) !== null || r.kind === "workshop" || r.kind === "hall"))("$name ($setup)", (room) => {
    expect(seatsIn(room.id)).toBeGreaterThanOrEqual(room.capacity);
    expect(seatsIn(room.id)).toBeLessThan(room.capacity + 10);
  });

  it("the venue with every setup is walkable", () => {
    expect(checkLayout(layout).ok).toBe(true);
  });
});

describe("what each setup is made of", () => {
  it("classroom: tables of three facing the stage, the Al Wasl Ballroom's 112", () => {
    const tables = itemsIn("plenary-0").filter((it) => it.t === "longTable");
    expect(tables.length).toBe(Math.ceil(112 / 3));
    const stage = itemsIn("plenary-0").find((it) => it.t === "stage");
    expect(stage).toBeDefined();
    for (const t of tables) if (t.t === "longTable") expect(t.both).toBeUndefined();
  });

  it("cabaret leaves the stage side of every table open; banquet seats ten all round", () => {
    const cab = itemsIn("hall-0").filter((it) => it.t === "round");
    expect(cab.length).toBeGreaterThan(0);
    for (const t of cab) if (t.t === "round") expect(typeof t.open).toBe("number");
    const ban = itemsIn("hall-1").filter((it) => it.t === "round");
    for (const t of ban) if (t.t === "round") {
      expect(t.open).toBeUndefined();
      expect(t.chairs).toBe(10);
    }
  });

  it("boardroom is one table with chairs down both sides and a screen, no stage", () => {
    const items = itemsIn("workshop-0");
    expect(items.filter((it) => it.t === "longTable")).toHaveLength(1);
    expect(items.some((it) => it.t === "longTable" && it.both)).toBe(true);
    expect(items.some((it) => it.t === "stage")).toBe(false);
    expect(items.some((it) => it.t === "screen")).toBe(true);
  });

  it("U-shape is three tables, the two arms facing each other", () => {
    const tables = itemsIn("workshop-1").filter((it): it is Extract<LayoutItem, { t: "longTable" }> => it.t === "longTable");
    expect(tables).toHaveLength(3);
    const [, left, right] = tables;
    expect(Math.abs(Math.abs(left.yaw - right.yaw) - Math.PI)).toBeLessThan(0.02);
  });
});

describe("no setup chosen: exactly as before", () => {
  it("a hall keeps its rows and a workshop its round tables of six", () => {
    expect(itemsIn("hall-2").some((it) => it.t === "row")).toBe(true);
    const rounds = itemsIn("workshop-2").filter((it) => it.t === "round");
    expect(rounds.length).toBeGreaterThan(0);
    for (const t of rounds) if (t.t === "round") expect(t.chairs).toBe(6);
  });

  it("a template's layout carries no setup on any room", () => {
    const l = generateLayout(TEMPLATES.congress.rooms, { eventName: "x" });
    expect(l.zones.every((z) => z.setup === undefined)).toBe(true);
  });

  it("theatre chosen out loud lays out like no setup at all", () => {
    const hall: VenueRoom = { id: "h", name: "H", kind: "hall", capacity: 120 };
    expect(fits({ ...hall, setup: "theatre" }, 18, 14)).toBe(fits(hall, 18, 14));
  });
});

describe("a setup changes what a room must measure", () => {
  it("120 people fit an 18 x 14 m hall in theatre rows, not round tables", () => {
    const hall: VenueRoom = { id: "h", name: "H", kind: "hall", capacity: 120 };
    expect(fits(hall, 18, 14)).toBe(true);
    expect(fits({ ...hall, setup: "banquet" }, 18, 14)).toBe(false);
  });
});

describe("what the room list accepts", () => {
  const base = TEMPLATES.meeting.rooms;
  const withPlenary = (patch: Partial<VenueRoom>) => base.map((r) => (r.kind === "plenary" ? { ...r, ...patch } : r));

  it("takes a setup on a seated room", () => {
    expect(roomsSchema.safeParse(withPlenary({ setup: "classroom" })).success).toBe(true);
  });

  it("refuses a setup on a room people do not sit in, and an unknown one", () => {
    const lounge = base.map((r) => (r.kind === "lounge" ? { ...r, setup: "banquet" as const } : r));
    const res = roomsSchema.safeParse(lounge);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toMatch(/only a room people sit in/);
    expect(roomsSchema.safeParse(withPlenary({ setup: "standing" as never })).success).toBe(false);
  });

  it("refuses more people than a boardroom or a U seats, saying what to change", () => {
    const res = roomsSchema.safeParse(withPlenary({ setup: "boardroom", capacity: 41 }));
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toMatch(/seats at most 40/);
    expect(roomsSchema.safeParse(withPlenary({ setup: "ushape", capacity: 60 })).success).toBe(true);
  });
});

describe("a Blueprint's layouts become setups", () => {
  const sp = (name: string, layout: string, cap: string): BlueprintSpace => ({ name, layout, cap, purpose: "" });

  it("classroom, cabaret and boardroom carry across to the seated rooms", () => {
    const { rooms } = roomsFromBlueprint([sp("Al Wasl Ballroom", "Classroom", "112"), sp("Hall B", "Cabaret", "120"), sp("Board room", "Boardroom", "18")], "300");
    const by = (n: string) => rooms.find((r) => r.name === n);
    expect(by("Al Wasl Ballroom")?.setup).toBe("classroom");
    expect(by("Hall B")?.setup).toBe("cabaret");
    expect(by("Board room")?.setup).toBe("boardroom");
    expect(roomsSchema.safeParse(rooms).success).toBe(true);
  });

  it("a boardroom too big to be one, or a layout on a room people do not sit in, is left as the kind's own", () => {
    const { rooms } = roomsFromBlueprint([sp("Main Stage", "Theatre", "300"), sp("Room 5", "Boardroom", "120"), sp("Gala Dinner", "Banquet rounds", "200")], "300");
    expect(rooms.find((r) => r.name === "Room 5")?.setup).toBeUndefined();
    expect(rooms.find((r) => r.name === "Gala Dinner")?.setup).toBeUndefined();
    expect(rooms.find((r) => r.name === "Main Stage")?.setup).toBeUndefined();
    expect(roomsSchema.safeParse(rooms).success).toBe(true);
  });
});
