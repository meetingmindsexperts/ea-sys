/**
 * The console roster.
 *
 * The union rule below was found by running the console against real local
 * data, NOT by a unit test: the first version built the roster from abstracts
 * alone, and a speaker who had consented but had no current non-draft abstract
 * came back as zero rows. A mocked-empty abstract list would never have shown
 * it, which is the argument for exercising a screen against real rows before
 * calling it done.
 *
 * MUTATIONS TO VERIFY AGAINST:
 *   - Drop the grant union -> the orphan-grant test fails, and a person who has
 *     already consented silently disappears from the console.
 *   - Dedupe by abstract instead of by speaker -> the D2 test fails.
 *   - Exclude UAE or unknown-country authors -> the D7 test fails, and a
 *     mis-classified author becomes unrecoverable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { abstractFindMany, grantFindMany } = vi.hoisted(() => ({
  abstractFindMany: vi.fn(),
  grantFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { abstract: { findMany: abstractFindMany }, travelGrant: { findMany: grantFindMany } },
}));

import { buildTravelGrantRoster } from "@/lib/travel-grant/console";

const speaker = (id: string, country: string | null, first = "A", last = id) => ({
  id,
  title: null,
  firstName: first,
  lastName: last,
  email: `${id}@x.com`,
  organization: "Hospital",
  country,
});

beforeEach(() => {
  vi.clearAllMocks();
  abstractFindMany.mockResolvedValue([]);
  grantFindMany.mockResolvedValue([]);
});

describe("buildTravelGrantRoster", () => {
  it("lists local and unknown-country authors too, so a mis-classified person is recoverable (D7)", async () => {
    abstractFindMany.mockResolvedValue([
      { speaker: speaker("sp1", "Oman") },
      { speaker: speaker("sp2", "United Arab Emirates") },
      { speaker: speaker("sp3", null) },
    ]);
    const rows = await buildTravelGrantRoster("ev1", ["AE"]);
    expect(rows.map((r) => r.residency).sort()).toEqual(["home", "overseas", "unknown"]);
  });

  it("shows one row per PERSON, not per abstract (D2)", async () => {
    abstractFindMany.mockResolvedValue([
      { speaker: speaker("sp1", "Oman") },
      { speaker: speaker("sp1", "Oman") },
      { speaker: speaker("sp1", "Oman") },
    ]);
    const rows = await buildTravelGrantRoster("ev1", ["AE"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].abstractCount).toBe(3);
  });

  it("still lists a grant whose author has NO current non-draft abstract", async () => {
    // Reachable two ways: the per-row send mints a grant for a corrected
    // country before the author resubmits, and an abstract can be withdrawn or
    // deleted afterwards. Either way, a person who consented must not vanish.
    abstractFindMany.mockResolvedValue([]);
    grantFindMany.mockResolvedValue([
      {
        id: "g1",
        speakerId: "sp9",
        status: "CONSENTED",
        token: "tok",
        invitedAt: null,
        submittedAt: new Date(),
        signedName: "Ana Silva",
        speaker: speaker("sp9", "Oman", "Ana", "Silva"),
      },
    ]);
    const rows = await buildTravelGrantRoster("ev1", ["AE"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ speakerId: "sp9", abstractCount: 0 });
    expect(rows[0].grant?.status).toBe("CONSENTED");
  });

  it("does not duplicate someone who has both an abstract and a grant", async () => {
    abstractFindMany.mockResolvedValue([{ speaker: speaker("sp1", "Oman") }]);
    grantFindMany.mockResolvedValue([
      {
        id: "g1",
        speakerId: "sp1",
        status: "PENDING",
        token: "t",
        invitedAt: null,
        submittedAt: null,
        signedName: null,
        speaker: speaker("sp1", "Oman"),
      },
    ]);
    const rows = await buildTravelGrantRoster("ev1", ["AE"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].grant?.id).toBe("g1");
    expect(rows[0].abstractCount).toBe(1);
  });

  it("puts confirmed authors first, then those still to reply", async () => {
    abstractFindMany.mockResolvedValue([
      { speaker: speaker("sp1", "United Arab Emirates", "Zed") },
      { speaker: speaker("sp2", "Oman", "Yan") },
      { speaker: speaker("sp3", "Egypt", "Xu") },
    ]);
    grantFindMany.mockResolvedValue([
      { id: "g2", speakerId: "sp2", status: "PENDING", token: "t", invitedAt: null, submittedAt: null, signedName: null, speaker: speaker("sp2", "Oman", "Yan") },
      { id: "g3", speakerId: "sp3", status: "CONSENTED", token: "t2", invitedAt: null, submittedAt: new Date(), signedName: "Xu", speaker: speaker("sp3", "Egypt", "Xu") },
    ]);
    const rows = await buildTravelGrantRoster("ev1", ["AE"]);
    expect(rows.map((r) => r.grant?.status ?? "NONE")).toEqual(["CONSENTED", "PENDING", "NONE"]);
  });

  it("excludes draft-only authors: a draft is not a submission", async () => {
    await buildTravelGrantRoster("ev1", ["AE"]);
    expect(abstractFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1", status: { not: "DRAFT" } } }),
    );
  });
});
