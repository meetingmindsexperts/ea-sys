/**
 * Custom sponsor tiers (Oct 15, 2026). Pins the rules a person relies on:
 *  - built-ins are fixed and come first; custom tiers follow;
 *  - renaming keeps the key, so every sponsor on the tier keeps it;
 *  - a new tier gets a key from its name, never one a built-in or another tier holds;
 *  - a name may not repeat any tier, standard or custom, ignoring case;
 *  - a tier a sponsor still uses cannot be deleted, and nothing is written;
 *  - all of it is decided on the LOCKED read, and a key a sponsor holds is never reused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    sponsor: { groupBy: vi.fn() },
    organization: { update: vi.fn() },
  };
  return {
    tx,
    mockDb: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      auditLog: { create: vi.fn() },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { saveSponsorTiers } from "@/services/sponsor-tier-service";
import { customSponsorTierKey, readCustomSponsorTiers, sponsorTierLabel, sponsorTierList, sponsorTierRank } from "@/lib/sponsor-tiers";

const ORG = "org-1";

/** The organisation row as the LOCKED read returns it. */
function orgWith(custom: { key: string; label: string }[]) {
  tx.$queryRaw.mockResolvedValue([{ settings: { timezone: "Asia/Dubai", sponsorTiers: custom } }]);
}
/** Tier keys sponsors in the organisation hold, with counts. */
function held(counts: Record<string, number>) {
  tx.sponsor.groupBy.mockResolvedValue(Object.entries(counts).map(([tier, n]) => ({ tier, _count: { _all: n } })));
}
const written = () => tx.organization.update.mock.calls[0]?.[0]?.data?.settings as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
  tx.organization.update.mockResolvedValue({});
  held({});
});

describe("sponsor tier list", () => {
  it("puts the built-ins first and the organisation's own after them", () => {
    const list = sponsorTierList([{ key: "associate", label: "Associate" }]);
    expect(list.map((t) => t.key)).toEqual(["platinum", "gold", "silver", "bronze", "partner", "exhibitor", "associate"]);
    expect(list.at(-1)).toEqual({ key: "associate", label: "Associate", builtIn: false });
    expect(sponsorTierRank("associate", list)).toBe(6);
    expect(sponsorTierRank("unknown", list)).toBe(7);
    expect(sponsorTierLabel("associate", list)).toBe("Associate");
    expect(sponsorTierLabel("gone", list)).toBe("gone");
  });

  it("never lets a custom entry shadow a built-in, and drops malformed settings", () => {
    expect(sponsorTierList([{ key: "gold", label: "Fake gold" }]).filter((t) => t.key === "gold")).toHaveLength(1);
    expect(readCustomSponsorTiers({ sponsorTiers: [{ key: "a" }, null, { key: "b", label: "B" }] })).toEqual([{ key: "b", label: "B" }]);
    expect(readCustomSponsorTiers(null)).toEqual([]);
  });

  it("makes a key from the name that nothing else holds", () => {
    expect(customSponsorTierKey("Associate", [])).toBe("associate");
    expect(customSponsorTierKey("Gold", ["gold"])).toBe("gold-2");
    expect(customSponsorTierKey("Media Partner!", [])).toBe("media-partner");
    expect(customSponsorTierKey("!!!", [])).toBe("tier");
  });
});

describe("saveSponsorTiers", () => {
  it("adds a tier and keeps the rest of the settings", async () => {
    orgWith([]);
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "Associate" }] });
    expect(res.ok).toBe(true);
    expect(written()).toEqual({ timezone: "Asia/Dubai", sponsorTiers: [{ key: "associate", label: "Associate" }] });
    if (res.ok) expect(res.tiers.at(-1)).toMatchObject({ key: "associate", label: "Associate", builtIn: false });
  });

  it("renames without changing the key", async () => {
    orgWith([{ key: "associate", label: "Associate" }]);
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ key: "associate", label: "Associate Partner" }] });
    expect(res.ok).toBe(true);
    expect(written()?.sponsorTiers).toEqual([{ key: "associate", label: "Associate Partner" }]);
  });

  it("refuses a name a standard tier already has, ignoring case", async () => {
    orgWith([]);
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "gold" }] });
    expect(res).toMatchObject({ ok: false, code: "DUPLICATE_LABEL" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("refuses the same name twice and an empty name", async () => {
    orgWith([]);
    expect(await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "A" }, { label: "a" }] })).toMatchObject({ code: "DUPLICATE_LABEL" });
    expect(await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "  " }] })).toMatchObject({ code: "INVALID_LABEL" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("answers not found for a missing organisation", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [] })).toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("refuses a key that is not one of the organisation's tiers", async () => {
    orgWith([]);
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ key: "gold", label: "Golden" }] });
    expect(res).toMatchObject({ ok: false, code: "UNKNOWN_TIER" });
  });

  it("refuses to delete a tier a sponsor still uses, says how many, and writes nothing", async () => {
    orgWith([{ key: "associate", label: "Associate" }]);
    held({ associate: 3, gold: 5 });
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [] });
    expect(res).toMatchObject({ ok: false, code: "TIER_IN_USE", inUse: [{ key: "associate", label: "Associate", sponsors: 3 }] });
    // Counted inside the transaction, through the event, for this organisation only.
    expect(tx.sponsor.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { event: { organizationId: ORG }, tier: { not: null } } }),
    );
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("plans from the LOCKED read, so a tier someone else just added and used is never silently dropped", async () => {
    // Another person added Associate and put a sponsor on it a moment ago; the
    // locked read sees it. A save built without it must be refused, not applied.
    orgWith([{ key: "associate", label: "Associate" }]);
    held({ associate: 1 });
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "Affiliate" }] });
    expect(res).toMatchObject({ ok: false, code: "TIER_IN_USE" });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("never gives a new tier a key a sponsor still holds", async () => {
    // Sponsors are still on "associate" though no tier has it any more.
    orgWith([]);
    held({ associate: 2 });
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "Associate" }] });
    expect(res.ok).toBe(true);
    expect(written()?.sponsorTiers).toEqual([{ key: "associate-2", label: "Associate" }]);
  });

  it("deletes a tier nobody uses", async () => {
    orgWith([{ key: "associate", label: "Associate" }]);
    const res = await saveSponsorTiers({ organizationId: ORG, actorUserId: "u1", tiers: [] });
    expect(res.ok).toBe(true);
    expect(written()?.sponsorTiers).toEqual([]);
  });
});
