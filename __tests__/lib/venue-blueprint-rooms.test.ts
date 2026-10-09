/**
 * The Blueprint's spaces as venue rooms (src/lib/venue/blueprint-rooms.ts,
 * phase 6 step 5): each space gets the kind its name, layout or purpose says;
 * the list is fitted to the venue's rules with a note for every change; and
 * whatever a Blueprint holds, the result is a list the venue accepts and lays
 * out walkably.
 */
import { describe, it, expect } from "vitest";
import { kindOfSpace, readBlueprintSpaces, roomsFromBlueprint, type BlueprintSpace } from "@/lib/venue/blueprint-rooms";
import { roomsSchema } from "@/lib/venue/rooms";
import { generateLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";

const sp = (name: string, layout = "", cap = "", purpose = ""): BlueprintSpace => ({ name, layout, cap, purpose });

describe("kindOfSpace", () => {
  it("reads the name first, then the layout, then the purpose", () => {
    expect(kindOfSpace(sp("Registration lounge", "Standing reception"))).toBe("foyer");
    expect(kindOfSpace(sp("E-poster area"))).toBe("posters");
    expect(kindOfSpace(sp("Room 4", "Exhibition stands"))).toBe("exhibition");
    expect(kindOfSpace(sp("Room 5", "Classroom"))).toBe("workshop");
    expect(kindOfSpace(sp("Main Stage", "Theatre"))).toBe("plenary");
    expect(kindOfSpace(sp("Garden", "Open or mixed", "", "coffee and networking between sessions"))).toBe("lounge");
    expect(kindOfSpace(sp("Room 6"))).toBe("hall");
  });

  it("leaves out a space with no physical room", () => {
    expect(kindOfSpace(sp("Livestream", "Online only"))).toBeNull();
  });
});

describe("roomsFromBlueprint", () => {
  it("turns a congress's spaces into its rooms", () => {
    const { rooms, notes } = roomsFromBlueprint(
      [sp("Registration", "Standing reception", "800"), sp("Plenary Hall", "Theatre", "600"), sp("Hall A", "Theatre", "150"), sp("Skills Lab", "Classroom", "40"), sp("Exhibition", "Exhibition stands", "400"), sp("Coffee Lounge", "Standing reception", "120"), sp("Online stream", "Online only")],
      "800 + 2,000 online",
    );
    expect(rooms.map((r) => [r.name, r.kind, r.capacity])).toEqual([
      ["Registration", "foyer", 800],
      ["Plenary Hall", "plenary", 600],
      ["Hall A", "hall", 150],
      ["Skills Lab", "workshop", 40],
      ["Exhibition", "exhibition", 400],
      ["Coffee Lounge", "lounge", 120],
    ]);
    expect(notes).toEqual(["Online stream is online only, so it has no room in the venue."]);
    expect(roomsSchema.safeParse(rooms).success).toBe(true);
  });

  it("adds the foyer sized from the attendance, and makes the largest hall the plenary", () => {
    const { rooms, notes } = roomsFromBlueprint([sp("Room A", "Theatre", "120"), sp("Room B", "Theatre", "300")], "about 350 delegates");
    expect(rooms.map((r) => [r.name, r.kind, r.capacity])).toEqual([["Foyer", "foyer", 350], ["Room B", "plenary", 300], ["Room A", "hall", 120]]);
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining("A foyer is added"), expect.stringContaining("Room B is the plenary hall")]));
  });

  it("notes every change it makes to fit the venue's rules", () => {
    const halls = Array.from({ length: 8 }, (_, i) => sp(`Hall ${i + 1}`, "Theatre", String(100 + i)));
    const { rooms, notes } = roomsFromBlueprint([sp("Lobby", "", "50000"), sp("Keynote Hall", "", "900"), sp("Ballroom", "", "700"), ...halls, sp("Bar", "", "5"), sp("Café", "", "60")], "");
    expect(roomsSchema.safeParse(rooms).success).toBe(true);
    expect(notes).toEqual(
      expect.arrayContaining([
        "Lobby holds 3000 people here, not 50000: a foyer holds 20 to 3000.",
        "Ballroom is a parallel hall: the venue has one plenary hall (Keynote Hall).",
        expect.stringMatching(/^Hall \d is left out: the venue has at most 6 parallel halls\.$/),
        "Bar is left out: the venue has one networking lounge (Café).",
      ]),
    );
    // the largest halls stay
    expect(rooms.filter((r) => r.kind === "hall").map((r) => r.name)).toEqual(expect.arrayContaining(["Ballroom", "Hall 8", "Hall 7"]));
  });

  it("gives a space with no number its kind's usual size, and repeated names their own", () => {
    const { rooms, notes } = roomsFromBlueprint([sp("Foyer"), sp("Session room", "Theatre", "100"), sp("Session room", "Theatre", "80")], "");
    expect(rooms.map((r) => r.name)).toEqual(["Foyer", "Session room", "Session room 2"]);
    expect(rooms[0].capacity).toBe(300);
    expect(notes).toContain("Foyer has no capacity in the Blueprint, so it starts at 300.");
    expect(new Set(rooms.map((r) => r.id)).size).toBe(3);
  });

  it("whatever the Blueprint holds, the rooms are valid and lay out walkably", () => {
    const words = ["Registration", "Lobby", "Plenary", "Main Stage", "Hall", "Breakout", "Workshop", "Skills Lab", "Posters", "Exhibition", "Sponsors", "Lounge", "Coffee", "Garden", "Room", "Studio", "Stream"];
    const layouts = ["", "Theatre", "Classroom", "Banquet rounds", "Cabaret", "Standing reception", "Boardroom", "U-shape", "Exhibition stands", "Standing crowd", "Open or mixed", "Online only"];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    for (let c = 0; c < 150; c++) {
      const spaces = Array.from({ length: Math.floor(rnd() * 22) }, () => sp(`${pick(words)} ${Math.floor(rnd() * 4)}`, pick(layouts), rnd() < 0.2 ? "" : String(Math.floor(rnd() * 5000))));
      const { rooms } = roomsFromBlueprint(spaces, rnd() < 0.5 ? "" : String(Math.floor(rnd() * 4000)));
      const label = JSON.stringify(spaces.map((s) => [s.name, s.layout, s.cap]));
      const parsed = roomsSchema.safeParse(rooms);
      expect(parsed.success ? [] : parsed.error.issues.map((i) => i.message), label).toEqual([]);
      expect(checkLayout(generateLayout(rooms, { eventName: "x" })).issues, label).toEqual([]);
    }
  }, 60_000);
});

describe("readBlueprintSpaces", () => {
  it("reads named spaces and the attendance, and ignores anything malformed", () => {
    expect(readBlueprintSpaces({ spaces: [{ name: " Hall ", cap: 120, layout: "Theatre" }, { name: "" }, "junk", null], basics: { attendance: "400" } })).toEqual({
      spaces: [{ name: "Hall", purpose: "", layout: "Theatre", cap: "120" }],
      attendance: "400",
    });
    expect(readBlueprintSpaces(null)).toEqual({ spaces: [], attendance: "" });
  });
});
