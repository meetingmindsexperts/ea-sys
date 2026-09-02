/**
 * saveSponsors: the diff, and the refusal that is the point of the table.
 *
 * The route test mocks this service, so without this file the new logic has no
 * coverage at all. What matters here is not that a save works, it is:
 *
 *   - a sponsor the payload drops but something still REFERENCES stops the
 *     whole save, rather than deleting and blanking attribution via SetNull;
 *   - the refusal ROLLS BACK the upserts too, so a save that cannot be applied
 *     whole is not applied in part;
 *   - merge mode keeps rows the payload never mentions, which is what an agent
 *     adding one sponsor means and what the old replace-by-default did not do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { saveSponsors } from "@/services/sponsor-service";

interface Row { id: string; name: string; tier: string | null; sortOrder?: number }

/** A tx whose sponsor table starts as `existing`, recording what happens to it. */
function txWith(existing: Row[], refs: { registrations?: Record<string, number>; promoCodes?: Record<string, number> } = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const deleted: string[][] = [];
  let n = 0;
  const tx = {
    sponsor: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
        select && "sortOrder" in select
          ? existing.map((e) => ({ id: e.id, sortOrder: e.sortOrder ?? 0 }))
          : existing.map((e) => ({ id: e.id, name: e.name, tier: e.tier })),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `new-${++n}`, ...data, logoUrl: null, websiteUrl: null, description: null };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push({ id: where.id, ...data });
        return { id: where.id, ...data, logoUrl: null, websiteUrl: null, description: null };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        deleted.push(where.id.in);
        return { count: where.id.in.length };
      }),
    },
    registration: {
      groupBy: vi.fn(async () =>
        Object.entries(refs.registrations ?? {}).map(([sponsorId, c]) => ({ sponsorId, _count: { _all: c } })),
      ),
    },
    promoCode: {
      groupBy: vi.fn(async () =>
        Object.entries(refs.promoCodes ?? {}).map(([sponsorId, c]) => ({ sponsorId, _count: { _all: c } })),
      ),
    },
  };
  return { tx, created, updated, deleted };
}

const base = { eventId: "ev-1", organizationId: "org-1", actorUserId: "u1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
});

describe("saveSponsors", () => {
  it("refuses to drop a sponsor a registration still references", async () => {
    const { tx, deleted } = txWith([{ id: "s1", name: "Abbott", tier: "gold" }], { registrations: { s1: 87 } });
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));

    const res = await saveSponsors({ ...base, sponsors: [], mode: "replace" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SPONSOR_IN_USE");
    expect(res.inUse).toEqual([{ id: "s1", name: "Abbott", registrations: 87, promoCodes: 0 }]);
    // Named, so the organiser learns WHAT is in the way rather than "save failed".
    expect(res.message).toContain("Abbott");
    expect(res.message).toContain("87");
    expect(deleted).toEqual([]);
  });

  it("refuses on a promo-code reference too, not just registrations", async () => {
    const { tx } = txWith([{ id: "s1", name: "Abbott", tier: null }], { promoCodes: { s1: 2 } });
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({ ...base, sponsors: [], mode: "replace" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.inUse?.[0].promoCodes).toBe(2);
  });

  it("deletes a dropped sponsor nothing references", async () => {
    const { tx, deleted } = txWith([{ id: "s1", name: "Abbott", tier: null }]);
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({ ...base, sponsors: [], mode: "replace" });
    expect(res.ok).toBe(true);
    expect(deleted).toEqual([["s1"]]);
  });

  it("merge mode keeps rows the payload never mentions", async () => {
    // The reason the MCP default flipped: an agent adding ONE sponsor and not
    // re-sending the other nine used to remove nine sponsors.
    const { tx, deleted, created } = txWith([{ id: "s1", name: "Abbott", tier: null, sortOrder: 0 }]);
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({ ...base, sponsors: [{ name: "Pfizer" }], mode: "merge" });
    expect(res.ok).toBe(true);
    expect(deleted).toEqual([]);
    // The new row lands AFTER the existing one rather than re-indexing from 0
    // and colliding with it.
    expect((created[0] as { sortOrder: number }).sortOrder).toBe(1);
  });

  it("matches an id-less payload row to an existing sponsor by name and tier", async () => {
    // Without this, re-sending the editor's list would delete and recreate
    // every sponsor, and every foreign key pointing at one would be blanked by
    // SetNull on the way through.
    const { tx, created, updated } = txWith([{ id: "s1", name: "Abbott", tier: "gold" }]);
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({ ...base, sponsors: [{ name: "  abbott ", tier: "gold" }], mode: "replace" });
    expect(res.ok).toBe(true);
    expect(created).toEqual([]);
    expect((updated[0] as { id: string }).id).toBe("s1");
  });

  it("rejects the same name at the same tier twice, without case", async () => {
    const { tx } = txWith([]);
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({
      ...base,
      sponsors: [{ name: "Abbott", tier: "gold" }, { name: "ABBOTT", tier: "gold" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DUPLICATE_NAME");
  });

  it("allows the same name at DIFFERENT tiers", async () => {
    const { tx } = txWith([]);
    mockDb.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const res = await saveSponsors({
      ...base,
      sponsors: [{ name: "Abbott", tier: "gold" }, { name: "Abbott", tier: "exhibitor" }],
    });
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown tier rather than storing it", async () => {
    const res = await saveSponsors({ ...base, sponsors: [{ name: "Abbott", tier: "diamond" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID_TIER");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("404s an event outside the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await saveSponsors({ ...base, sponsors: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("EVENT_NOT_FOUND");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
