/**
 * "What has this person already told us": ONE rule for the abstract sign-in
 * door and the event's My Details (review of 5c66e67d, Nov 10, 2026). The two
 * had their own source lists and disagreed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Reads only: a write through this module is a TypeError, which fails the test.
const { db } = vi.hoisted(() => ({
  db: {
    accountProfile: { findUnique: vi.fn() },
    speaker: { findMany: vi.fn() },
    registration: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db }));

import { firstGiven, loadOwnDetailSources } from "@/lib/own-details-sources";

const proven = { userId: "u1", email: "john_smith@x.co", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  db.accountProfile.findUnique.mockResolvedValue(null);
  db.speaker.findMany.mockResolvedValue([]);
  db.registration.findMany.mockResolvedValue([]);
});

describe("loadOwnDetailSources", () => {
  it("orders the account's saved details, then speaker records, then registrations", async () => {
    db.accountProfile.findUnique.mockResolvedValue({ userId: "u1", organization: "Saved" });
    db.speaker.findMany.mockResolvedValue([{ bio: "Speaker bio" }]);
    db.registration.findMany.mockResolvedValue([{ attendee: { city: "" } }, { attendee: { city: "Dubai" } }]);

    const sources = await loadOwnDetailSources({ userId: "u1", scope: proven, exceptEventId: "ev1" });

    expect(sources).toEqual([{ userId: "u1", organization: "Saved" }, { bio: "Speaker bio" }, { city: "" }, { city: "Dubai" }]);
    // A sparse latest registration (a speaker's companion) no longer hides the one before it.
    expect(firstGiven(sources, "city")).toBe("Dubai");
    expect(db.registration.findMany.mock.calls[0][0]).toMatchObject({ take: 3, orderBy: { createdAt: "desc" } });
  });

  it("an unproven address reads LINKED rows only", async () => {
    await loadOwnDetailSources({ userId: "u1", scope: { ...proven, confirmed: false } });
    expect(db.speaker.findMany.mock.calls[0][0].where).toEqual({ userId: "u1" });
    expect(db.registration.findMany.mock.calls[0][0].where).toEqual({ status: { not: "CANCELLED" }, userId: "u1" });
  });

  it("a proven address adds the UNCLAIMED rows on it, the underscore escaped, never another account's", async () => {
    await loadOwnDetailSources({ userId: "u1", scope: proven, exceptEventId: "ev1" });
    expect(db.speaker.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ userId: "u1" }, { userId: null, email: { equals: "john\\_smith@x.co", mode: "insensitive" } }],
      eventId: { not: "ev1" },
    });
  });

  it("an account that could not be read still gets its linked rows, and cancelled registrations are left out", async () => {
    await loadOwnDetailSources({ userId: "u1", scope: null });
    expect(db.registration.findMany.mock.calls[0][0].where).toEqual({ status: { not: "CANCELLED" }, userId: "u1" });
  });
});

describe("firstGiven", () => {
  it("skips blanks and missing sources, and trims", () => {
    expect(firstGiven([null, { phone: "  " }, undefined, { phone: " 050 " }, { phone: "last" }], "phone")).toBe("050");
    expect(firstGiven([{ phone: null }], "phone")).toBe("");
  });
});
