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
    abstract: { count: vi.fn() },
    abstractReviewSubmission: { count: vi.fn() },
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

/**
 * Abstract rows as (type, request) and reviews by format. The fakes answer the
 * queries the service really sends: per key, an abstract whose type OR request
 * is the key (review of 6e04916ec: the first fake matched only rows whose two
 * columns were equal, which hid a count that missed every other abstract).
 */
function holding(abstracts: Array<[string | null, string | null]>, reviews: string[] = []) {
  tx.abstract.count.mockImplementation(async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
    const key = where.OR[0].presentationType;
    return abstracts.filter(([type, request]) => type === key || request === key).length;
  });
  tx.abstractReviewSubmission.count.mockImplementation(async ({ where }: { where: { recommendedFormat: string } }) =>
    reviews.filter((r) => r === where.recommendedFormat).length,
  );
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

  it("an abstract staff moved to a type, with its author's request on another, holds BOTH (the review's BLOCKER)", async () => {
    holding([["SYMPOSIUM", "ORAL"], ["ORAL", "ORAL_POSTER"]]);
    const result = await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }));
    expect(result).toMatchObject({ ok: false, code: "IN_USE" });
    mockDb.organization.findUnique.mockResolvedValue({ settings: ORG_SETTINGS });
    const list = await listPresentationTypesWithUse("org1");
    expect(list?.find((t) => t.key === "SYMPOSIUM")?.inUse).toBe(1);
    expect(list?.find((t) => t.key === "ORAL")?.inUse).toBe(2);
    expect(list?.find((t) => t.key === "ORAL_POSTER")?.inUse).toBe(1);
  });

  it("counts through the abstract's event, never the row's own organisation stamp", async () => {
    await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }));
    for (const call of tx.abstract.count.mock.calls) expect(call[0].where.event).toEqual({ organizationId: "org1" });
    expect(tx.abstractReviewSubmission.count.mock.calls[0][0].where.abstract).toEqual({ event: { organizationId: "org1" } });
  });

  it("keeps a deleted type's key, and a new type with the same name never takes it", async () => {
    await changePresentationType(input({ action: "delete", key: "SYMPOSIUM" }));
    const afterDelete = tx.organization.update.mock.calls[0][0].data.settings;
    expect(afterDelete.presentationTypesDeleted).toEqual(["SYMPOSIUM"]);
    tx.$queryRaw.mockResolvedValueOnce([{ settings: afterDelete }]);
    const added = await changePresentationType(input({ action: "add", label: "Symposium" }));
    expect(added).toMatchObject({ ok: true, key: "SYMPOSIUM_2" });
    expect(tx.organization.update.mock.calls[1][0].data.settings.presentationTypesDeleted).toEqual(["SYMPOSIUM"]);
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
