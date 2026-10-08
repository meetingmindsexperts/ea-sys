/**
 * lib/venue/rooms.ts (D9, D10): the room list the walkable venue is built
 * from. Every template must be saveable as it stands; the rules refuse what the
 * fixed floor plan cannot lay out, with a reason an organiser can act on.
 */
import { describe, it, expect } from "vitest";
import { ROOM_KIND_INFO, TEMPLATES, TEMPLATE_KEYS, readVenueRooms, roomIdFor, roomsSchema, type VenueRoom } from "@/lib/venue/rooms";

const messages = (rooms: unknown) => {
  const r = roomsSchema.safeParse(rooms);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const congress = (): VenueRoom[] => TEMPLATES.congress.rooms.map((r) => ({ ...r }));

describe("templates", () => {
  it.each(TEMPLATE_KEYS)("%s is a valid venue as it stands", (key) => {
    expect(messages(TEMPLATES[key].rooms)).toEqual([]);
  });
});

describe("room rules", () => {
  it("needs exactly one foyer", () => {
    expect(messages(congress().filter((r) => r.kind !== "foyer"))).toContain("The venue needs a foyer");
    expect(messages([...congress(), { id: "foyer-2", name: "Second foyer", kind: "foyer", capacity: 100 }])).toContain("Only one foyer");
  });

  it("limits each kind to what the floor plan can lay out", () => {
    const halls = Array.from({ length: 7 }, (_, i) => ({ id: `h${i}`, name: `Hall ${i}`, kind: "hall" as const, capacity: 100 }));
    expect(messages([congress()[0], ...halls])).toContain("At most 6 parallel halls");
  });

  it("checks each room's size against its kind, in words", () => {
    expect(messages(congress().map((r) => (r.kind === "workshop" ? { ...r, capacity: 900 } : r)))).toContain("Workshop Room: a workshop room holds 10 to 200 people");
    expect(messages(congress().map((r) => (r.kind === "lounge" ? { ...r, capacity: Number.NaN } : r)))).toContain("Enter how many people each room holds");
  });

  it("refuses two rooms with the same name, whatever the case", () => {
    const rooms = congress();
    rooms[3] = { ...rooms[3], name: "hall a " };
    expect(messages(rooms)).toContain('Two rooms are called "hall a"; give each its own name');
  });

  it("refuses an empty name and odd ids", () => {
    expect(messages(congress().map((r, i) => (i === 2 ? { ...r, name: "  " } : r)))).toContain("Give every room a name");
    expect(messages(congress().map((r, i) => (i === 2 ? { ...r, id: "../x" } : r))).length).toBeGreaterThan(0);
  });

  it("every kind's starting size is within its own limits", () => {
    for (const info of Object.values(ROOM_KIND_INFO)) {
      expect(info.capacity.start).toBeGreaterThanOrEqual(info.capacity.min);
      expect(info.capacity.start).toBeLessThanOrEqual(info.capacity.max);
    }
  });
});

describe("readVenueRooms and roomIdFor", () => {
  it("reads a saved list, and treats a list that no longer passes as none", () => {
    const list = congress();
    expect(readVenueRooms({ venue: { rooms: { list, updatedAt: 5, updatedBy: "u-1" } } })).toEqual({ rooms: list, updatedAt: 5, updatedBy: "u-1" });
    expect(readVenueRooms({ venue: { rooms: { list: [{ id: "x" }] } } })).toBeNull();
    expect(readVenueRooms({})).toBeNull();
  });

  it("makes ids from names, unique within the list", () => {
    expect(roomIdFor("Hall D (East)", [])).toBe("hall-d-east");
    expect(roomIdFor("Hall A", ["hall-a"])).toBe("hall-a-2");
    expect(roomIdFor("!!!", [])).toBe("room");
  });
});
