/**
 * The programme inside the online venue (src/lib/venue/programme.ts, phase 6
 * step 4): a session is in the room its location or track names (location
 * first), sponsors take stands by tier, links and logos are safe to load, and
 * the AI is told one day's sessions room by room.
 */
import { describe, it, expect } from "vitest";
import { buildProgramme, matchRoom, orderSponsors, programmeDay, programmeForAi, roomOfSession, type SessionInput } from "@/lib/venue/programme";
import type { SponsorEntry } from "@/lib/webinar";

const rooms = [
  { id: "plenary", name: "Plenary Hall" },
  { id: "hall-a", name: "Hall A" },
  { id: "hall-b", name: "Hall B" },
  { id: "workshop", name: "Workshop Room" },
];
const tz = "Asia/Dubai";
const at = (iso: string) => new Date(iso);
const session = (name: string, start: string, end: string, more: Partial<SessionInput> = {}): SessionInput => ({ name, startTime: at(start), endTime: at(end), location: null, track: null, ...more });

describe("matchRoom", () => {
  it("matches a room's name whatever the case, spacing, punctuation or a leading 'the'", () => {
    expect(matchRoom(rooms, "plenary hall")).toBe("plenary");
    expect(matchRoom(rooms, "  The Plenary-Hall ")).toBe("plenary");
    expect(matchRoom(rooms, "HALL  B")).toBe("hall-b");
  });

  it("takes the part before a separator, as teams write 'Main Hall — Al Majlis'", () => {
    expect(matchRoom(rooms, "Hall A — level 2")).toBe("hall-a");
    expect(matchRoom(rooms, "Hall B (MOVED due to speaker swap)")).toBe("hall-b");
    expect(matchRoom(rooms, "Workshop Room, east wing")).toBe("workshop");
  });

  it("never guesses: a partial or unknown name is no room", () => {
    expect(matchRoom(rooms, "Hall")).toBeNull();
    expect(matchRoom(rooms, "Hall C")).toBeNull();
    expect(matchRoom(rooms, "Track 1")).toBeNull();
    expect(matchRoom(rooms, "")).toBeNull();
    expect(matchRoom(rooms, null)).toBeNull();
  });
});

describe("roomOfSession", () => {
  it("uses the location first, then the track", () => {
    expect(roomOfSession(rooms, { location: "Hall A", track: "Plenary Hall" })).toBe("hall-a");
    expect(roomOfSession(rooms, { location: null, track: "Plenary Hall" })).toBe("plenary");
    expect(roomOfSession(rooms, { location: "Somewhere else", track: "Workshop Room" })).toBe("workshop");
  });
});

describe("orderSponsors", () => {
  const sp = (name: string, tier?: string, more: Partial<SponsorEntry> = {}) => ({ id: name, name, sortOrder: 0, ...(tier && { tier }), ...more }) as SponsorEntry;

  it("puts sponsors in tier order, keeping the team's order within a tier and untiered last", () => {
    const out = orderSponsors([sp("Partner Co", "partner"), sp("No Tier"), sp("Gold One", "gold"), sp("Plat", "platinum"), sp("Gold Two", "gold")]);
    expect(out.map((s) => s.name)).toEqual(["Plat", "Gold One", "Gold Two", "Partner Co", "No Tier"]);
  });

  it("passes only links and logos the page may load", () => {
    const [a, b] = orderSponsors([
      sp("Safe", "gold", { websiteUrl: "https://safe.example", logoUrl: "/uploads/logos/a.png" }),
      sp("Unsafe", "gold", { websiteUrl: "javascript:alert(1)", logoUrl: "http://plain.example/x.png" }),
    ]);
    expect(a).toMatchObject({ website: "https://safe.example", logo: "/uploads/logos/a.png" });
    expect(b.website).toBeUndefined();
    expect(b.logo).toBeUndefined();
  });
});

describe("buildProgramme", () => {
  it("places sessions in time order and keeps what an unplaced one says", () => {
    const p = buildProgramme(
      rooms,
      [
        session("Later", "2026-10-24T08:00:00Z", "2026-10-24T09:00:00Z", { track: "Plenary Hall" }),
        session("Opening", "2026-10-24T05:00:00Z", "2026-10-24T06:00:00Z", { location: "Plenary Hall" }),
        session("Lost", "2026-10-24T06:00:00Z", "2026-10-24T07:00:00Z", { location: "Al Majlis" }),
      ],
      [],
      tz,
    );
    expect(p.sessions.map((s) => [s.title, s.room])).toEqual([["Opening", "plenary"], ["Lost", null], ["Later", "plenary"]]);
    expect(p.sessions[1].where).toBe("Al Majlis");
    expect(p.sessions[0].where).toBeUndefined();
  });
});

describe("programmeDay and programmeForAi", () => {
  const p = buildProgramme(
    rooms,
    [
      session("Opening plenary", "2026-10-24T05:00:00Z", "2026-10-24T06:30:00Z", { track: "Plenary Hall" }),
      session("Thrombosis update", "2026-10-24T07:00:00Z", "2026-10-24T08:00:00Z", { track: "Haematology", location: "Hall A" }),
      session("Day two keynote", "2026-10-25T05:00:00Z", "2026-10-25T06:00:00Z", { track: "Plenary Hall" }),
    ],
    [{ id: "s1", name: "Novartis Middle East", tier: "platinum", sortOrder: 0 }, { id: "s2", name: "Pfizer MENA", tier: "silver", sortOrder: 1 }],
    tz,
  );

  it("talks about today when the programme has it, else the first day ahead, else the last day", () => {
    expect(programmeDay(p, at("2026-10-25T10:00:00Z"))).toBe("2026-10-25");
    expect(programmeDay(p, at("2026-10-01T10:00:00Z"))).toBe("2026-10-24");
    expect(programmeDay(p, at("2026-11-30T10:00:00Z"))).toBe("2026-10-25");
  });

  it("tells the AI that day's sessions room by room, in local time, and the sponsors with stands", () => {
    const text = programmeForAi(p, rooms, at("2026-10-01T10:00:00Z"), 12)!;
    expect(text).toContain("Saturday 24 October");
    expect(text).toContain("Plenary Hall: 09:00-10:30 Opening plenary.");
    expect(text).toContain("Hall A: 11:00-12:00 Thrombosis update (Haematology track).");
    expect(text).not.toContain("Day two keynote");
    expect(text).toContain("Sponsors with stands in the exhibition: Novartis Middle East, Pfizer MENA.");
  });

  it("names only the sponsors that have a stand, and nothing when there is nothing to tell", () => {
    expect(programmeForAi(p, rooms, at("2026-10-01T10:00:00Z"), 1)).toContain("exhibition: Novartis Middle East.");
    expect(programmeForAi(p, rooms, at("2026-10-01T10:00:00Z"), 0)).not.toContain("Sponsors");
    expect(programmeForAi(buildProgramme(rooms, [], [], tz), rooms, new Date(), 12)).toBeNull();
  });
});
