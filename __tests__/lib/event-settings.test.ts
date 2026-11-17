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
// The merge runs as a tenant transaction, which on master IS `db.$transaction`.
const tenantTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction }));

import { updateEventSettings, updateOrganizationSettings } from "@/lib/event-settings";

beforeEach(() => {
  vi.clearAllMocks();
  tenantTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => mockDb.$transaction(fn));
});

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

describe("updateEventSettings bound to an organisation (venue tenancy review, Oct 27)", () => {
  it("locks the row only within that organisation, and an event of another reads as not found", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([]);
    await expect(updateEventSettings("ev1", { a: 1 }, { organizationId: "org-1" })).rejects.toThrow("EVENT_NOT_FOUND");
    const [sql, ...values] = mockDb._tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).toContain('"organizationId" = ?');
    expect(values).toEqual(["ev1", "org-1"]);
    expect(mockDb._tx.event.update).not.toHaveBeenCalled();
  });

  it("without one, locks by id alone, as every other caller does", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: {} }]);
    await updateEventSettings("ev1", { a: 1 });
    const [sql, ...values] = mockDb._tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).not.toContain("organizationId");
    expect(values).toEqual(["ev1"]);
  });
});

describe("the merge is a TENANT transaction (review of 2db57e7f)", () => {
  it("never opens a plain transaction of its own: the raw row lock is not a model operation, so only the tenant transaction tells its backend whose rows it may see", async () => {
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: {} }]);
    // A stand-in that does NOT go through db.$transaction: the merge must still run inside it.
    tenantTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockDb._tx));
    await updateEventSettings("ev1", { a: 1 });
    await updateOrganizationSettings("org1", { b: 2 });
    expect(tenantTransaction).toHaveBeenCalledTimes(2);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb._tx.event.update).toHaveBeenCalledTimes(1);
    expect(mockDb._tx.organization.update).toHaveBeenCalledTimes(1);
  });
});

describe("updateEventSettings and the tenant lane (Event RLS, Nov 17 2026)", () => {
  // The merge is a tenant transaction: with no lane around it, it is a plain one, which finds no
  // row where Event has a policy. So it enters the lane of the organisation it is HANDED, but only
  // when its caller is outside every lane. The real tenant context is used here; only the database is mocked.
  let laneSeen: string | undefined | null;
  beforeEach(() => {
    laneSeen = null;
    mockDb._tx.$queryRaw.mockResolvedValue([{ settings: {} }]);
    tenantTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { getTenantStore } = await import("@/lib/tenant-context");
      laneSeen = getTenantStore()?.orgId;
      return mockDb.$transaction(fn);
    });
  });

  it("a caller outside every lane that names the organisation gets that organisation's lane", async () => {
    // What the catalogue settings PATCH and the user-delete clean-up rely on.
    await updateEventSettings("ev1", { a: 1 }, { organizationId: "org-1" });
    expect(laneSeen).toBe("org-1");
  });

  it("a caller that names none is left as it is: it must already be inside a lane", async () => {
    await updateEventSettings("ev1", { a: 1 });
    expect(laneSeen).toBeUndefined();
  });

  it("a caller already inside a lane keeps it, whatever organisation it names", async () => {
    const { runWithTenant } = await import("@/lib/tenant-context");
    // Naming another organisation from inside a lane is never a way out of the lane.
    await runWithTenant("org-A", () => updateEventSettings("ev1", { a: 1 }, { organizationId: "org-B" }));
    expect(laneSeen).toBe("org-A");
  });

  it("the fail-closed EMPTY lane is a lane too: a caller inside it stays there", async () => {
    const { runWithTenant } = await import("@/lib/tenant-context");
    await runWithTenant("", () => updateEventSettings("ev1", { a: 1 }, { organizationId: "org-1" }));
    expect(laneSeen).toBe("");
  });
});
