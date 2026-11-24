/**
 * Changing the organisation's presentation types (Nov 24, 2026; step 3 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md): one change under the
 * organisation's row lock, the use count a delete asks, the audit row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, mockDb, logger, resetCache } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    organization: { update: vi.fn() },
    abstract: { groupBy: vi.fn() },
    abstractReviewSubmission: { groupBy: vi.fn() },
  };
  return {
    tx,
    mockDb: {
      auditLog: { create: vi.fn() },
      organization: { findUnique: vi.fn() },
      abstract: tx.abstract,
      abstractReviewSubmission: tx.abstractReviewSubmission,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resetCache: vi.fn(),
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (t: unknown) => unknown) => fn(tx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/abstract-presentation-types-server", () => ({ resetPresentationTypeCache: resetCache }));

import { changePresentationType, listPresentationTypesWithUse } from "@/services/presentation-type-service";

const ORG_SETTINGS = { website: "https://x.example", presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium", retired: false }] };
const input = (change: Parameters<typeof changePresentationType>[0]["change"]) => ({ organizationId: "org1", actorUserId: "u1", source: "rest" as const, change });

/** Abstract rows by (type, request), and reviews by format. */
function holding(abstracts: Array<[string | null, string | null]>, reviews: string[] = []) {
  const count = (pick: (a: [string | null, string | null]) => string | null, keep: (a: [string | null, string | null]) => boolean = () => true) => {
    const m = new Map<string, number>();
    abstracts.filter(keep).forEach((a) => {
      const k = pick(a);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    });
    return [...m];
  };
  tx.abstract.groupBy.mockImplementation(async ({ by, where }: { by: string[]; where: Record<string, unknown> }) => {
    const both = "presentationType" in where && "requestedPresentationType" in where;
    if (both) return count((a) => (a[0] === a[1] ? a[0] : null)).map(([k, n]) => ({ presentationType: k, _count: { _all: n } }));
    if (by[0] === "presentationType") return count((a) => a[0]).map(([k, n]) => ({ presentationType: k, _count: { _all: n } }));
    return count((a) => a[1]).map(([k, n]) => ({ requestedPresentationType: k, _count: { _all: n } }));
  });
  const m = new Map<string, number>();
  reviews.forEach((r) => m.set(r, (m.get(r) ?? 0) + 1));
  tx.abstractReviewSubmission.groupBy.mockResolvedValue([...m].map(([k, n]) => ({ recommendedFormat: k, _count: { _all: n } })));
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ settings: ORG_SETTINGS }]);
  tx.organization.update.mockResolvedValue({});
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({}));
  holding([]);
});

describe("changePresentationType", () => {
  it("adds a type in the locked update, keeps the other settings, clears the cache and writes the audit row", async () => {
    const result = await changePresentationType(input({ action: "add", label: "Case report" }));
    expect(result).toMatchObject({ ok: true, key: "CASE_REPORT" });
    const data = tx.organization.update.mock.calls[0][0].data.settings;
    expect(data.website).toBe("https://x.example");
    expect(data.presentationTypes.map((t: { key: string }) => t.key)).toEqual(["ORAL_POSTER", "ORAL", "POSTER", "VIDEO", "WORKSHOP", "SYMPOSIUM", "CASE_REPORT"]);
    expect(resetCache).toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: "org1", entityType: "Organization" }) }));
  });

  it("counts what holds a type, an abstract once even when its type and request are the same, and refuses to delete it", async () => {
    holding([["SYMPOSIUM", "SYMPOSIUM"], ["ORAL", "SYMPOSIUM"]], ["SYMPOSIUM"]);
    const result = await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }));
    expect(result).toMatchObject({ ok: false, code: "IN_USE" });
    expect(result.ok ? "" : result.message).toMatch(/^3 /);
    expect(tx.organization.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "presentation-types:change-refused", code: "IN_USE" }));
  });

  it("counts through the abstract's event, never the row's own organisation stamp", async () => {
    await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }));
    for (const call of tx.abstract.groupBy.mock.calls) expect(call[0].where.event).toEqual({ organizationId: "org1" });
    expect(tx.abstractReviewSubmission.groupBy.mock.calls[0][0].where.abstract).toEqual({ event: { organizationId: "org1" } });
  });

  it("deletes a type nothing holds", async () => {
    expect(await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }))).toMatchObject({ ok: true });
    expect(tx.organization.update.mock.calls[0][0].data.settings.presentationTypes.map((t: { key: string }) => t.key)).not.toContain("SYMPOSIUM");
  });

  it("a missing organisation, and a failed write, are answered and logged; nothing is cached as saved", async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await changePresentationType(input({ action: "retire", key: "VIDEO" }))).toMatchObject({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
    tx.organization.update.mockRejectedValueOnce(new Error("db down"));
    expect(await changePresentationType(input({ action: "retire", key: "VIDEO" }))).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "presentation-types:change-failed" }));
    expect(resetCache).not.toHaveBeenCalled();
  });
});

describe("listPresentationTypesWithUse", () => {
  it("lists every type with what holds it", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: ORG_SETTINGS });
    holding([["ORAL", "ORAL"], ["POSTER", "ORAL_POSTER"]]);
    const list = await listPresentationTypesWithUse("org1");
    expect(list?.find((t) => t.key === "ORAL")?.inUse).toBe(1);
    expect(list?.find((t) => t.key === "POSTER")?.inUse).toBe(1);
    expect(list?.find((t) => t.key === "ORAL_POSTER")?.inUse).toBe(1);
    expect(list?.find((t) => t.key === "SYMPOSIUM")?.inUse).toBe(0);
  });

  it("no organisation, no list", async () => {
    mockDb.organization.findUnique.mockResolvedValue(null);
    expect(await listPresentationTypesWithUse("gone")).toBeNull();
  });
});
