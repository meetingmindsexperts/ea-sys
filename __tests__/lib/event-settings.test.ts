/**
 * updateEventSettings / updateOrganizationSettings — atomic, race-safe merge of
 * the settings JSON blob (SELECT … FOR UPDATE inside a tx). Pins the two patch
 * modes (object shallow-merge vs function full-replace), null handling, and the
 * not-found errors. The actual row lock is a DB property; here we verify the
 * read-merge-write semantics around the locked read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    event: { update: vi.fn().mockResolvedValue({}) },
    organization: { update: vi.fn().mockResolvedValue({}) },
  };
  return { mockDb: { $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)), _tx: tx } };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { updateEventSettings, updateOrganizationSettings } from "@/lib/event-settings";

beforeEach(() => vi.clearAllMocks());

describe("updateEventSettings — atomic merge", () => {
  it("object patch shallow-merges, preserving unspecified (sibling) keys", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: { a: 1, b: 2, webinar: { x: 1 } } }]);
    const merged = await updateEventSettings("ev1", { b: 3, c: 4 });
    expect(merged).toEqual({ a: 1, b: 3, c: 4, webinar: { x: 1 } });
    expect(mockDb._tx.event.update).toHaveBeenCalledWith({
      where: { id: "ev1" },
      data: { settings: { a: 1, b: 3, c: 4, webinar: { x: 1 } } },
    });
  });

  it("function patch returns the complete next settings (append computed from locked current)", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: { reviewerUserIds: ["x"], sponsors: [] } }]);
    const merged = await updateEventSettings("ev1", (cur) => ({
      ...cur,
      reviewerUserIds: [...((cur.reviewerUserIds as string[]) ?? []), "y"],
    }));
    expect(merged).toEqual({ reviewerUserIds: ["x", "y"], sponsors: [] });
  });

  it("treats null settings as an empty object", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: null }]);
    expect(await updateEventSettings("ev1", { k: 1 })).toEqual({ k: 1 });
  });

  it("throws EVENT_NOT_FOUND when the row is gone (no write)", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([]);
    await expect(updateEventSettings("nope", { k: 1 })).rejects.toThrow("EVENT_NOT_FOUND");
    expect(mockDb._tx.event.update).not.toHaveBeenCalled();
  });
});

describe("updateOrganizationSettings — atomic merge", () => {
  it("merges + writes the organization row", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: { zoom: { a: 1 } } }]);
    const merged = await updateOrganizationSettings("org1", { eventsAir: { b: 2 } });
    expect(merged).toEqual({ zoom: { a: 1 }, eventsAir: { b: 2 } });
    expect(mockDb._tx.organization.update).toHaveBeenCalledWith({
      where: { id: "org1" },
      data: { settings: { zoom: { a: 1 }, eventsAir: { b: 2 } } },
    });
  });

  it("throws ORGANIZATION_NOT_FOUND when gone", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([]);
    await expect(updateOrganizationSettings("nope", {})).rejects.toThrow("ORGANIZATION_NOT_FOUND");
  });
});
