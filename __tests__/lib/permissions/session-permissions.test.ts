/**
 * The cookie carries a person's custom roles as [id, version]; the keys are
 * resolved here (custom roles Phase 1 slice 3, ROADMAP "Session cookie size").
 * Pinned: the cache is keyed on version so an edit is seen at once, an archived
 * role grants nothing, reads run in the token's tenant lane, a failure never
 * throws, and the cookie no longer grows with the keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRunWithTenant, mockWarn } = vi.hoisted(() => ({
  mockDb: { userPermissionSet: { findMany: vi.fn() }, permissionSet: { findMany: vi.fn() } },
  mockRunWithTenant: vi.fn((_org: string, fn: () => unknown) => fn()),
  mockWarn: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: mockRunWithTenant }));
vi.mock("@/lib/logger", () => ({ authLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() } }));

import {
  COOKIE_WARN_BYTES,
  clearSessionPermissionCache,
  estimatedCookieBytes,
  permissionsForHeldSets,
  readHeldSets,
} from "@/lib/permissions/session-permissions";

const set = (id: string, version: number, keys: string[], archivedAt: Date | null = null) => ({
  id,
  version,
  archivedAt,
  permissions: keys.map((permission) => ({ permission })),
});

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionPermissionCache();
});

describe("readHeldSets", () => {
  it("reads live, non-system roles as [id, version] inside the tenant lane", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      { permissionSet: { id: "a", version: 3 } },
      { permissionSet: { id: "b", version: 1 } },
    ]);
    expect(await readHeldSets("org-1", "u")).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
    expect(mockRunWithTenant).toHaveBeenCalledWith("org-1", expect.any(Function));
    expect(mockDb.userPermissionSet.findMany.mock.calls[0][0].where).toEqual({
      organizationId: "org-1",
      userId: "u",
      permissionSet: { archivedAt: null, isSystem: false },
    });
  });
});

describe("permissionsForHeldSets", () => {
  it("unions live keys across roles and drops keys the build does not enforce", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      set("a", 1, ["procurement.budgets.view", "procurement.requests.create"]),
      set("b", 2, ["procurement.budgets.view", "events.delete", "procurement.budgets.reopen"]),
    ]);
    const keys = await permissionsForHeldSets("org-1", [
      ["a", 1],
      ["b", 2],
    ]);
    expect(keys.sort()).toEqual(["procurement.budgets.view", "procurement.requests.create"]);
    expect(mockRunWithTenant).toHaveBeenCalledWith("org-1", expect.any(Function));
  });

  it("answers from the cache on a repeat, with no query", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([set("a", 1, ["procurement.budgets.view"])]);
    await permissionsForHeldSets("org-1", [["a", 1]]);
    await permissionsForHeldSets("org-1", [["a", 1]]);
    expect(mockDb.permissionSet.findMany).toHaveBeenCalledTimes(1);
  });

  it("sees an edit at once: a new version is a new cache entry", async () => {
    mockDb.permissionSet.findMany.mockResolvedValueOnce([set("a", 1, ["procurement.budgets.view"])]);
    expect(await permissionsForHeldSets("org-1", [["a", 1]])).toEqual(["procurement.budgets.view"]);
    mockDb.permissionSet.findMany.mockResolvedValueOnce([set("a", 2, ["procurement.orders.view"])]);
    expect(await permissionsForHeldSets("org-1", [["a", 2]])).toEqual(["procurement.orders.view"]);
    expect(mockDb.permissionSet.findMany).toHaveBeenCalledTimes(2);
  });

  it("reads only the roles missing from the cache", async () => {
    mockDb.permissionSet.findMany.mockResolvedValueOnce([set("a", 1, ["procurement.budgets.view"])]);
    await permissionsForHeldSets("org-1", [["a", 1]]);
    mockDb.permissionSet.findMany.mockResolvedValueOnce([set("b", 1, ["procurement.orders.view"])]);
    await permissionsForHeldSets("org-1", [
      ["a", 1],
      ["b", 1],
    ]);
    expect(mockDb.permissionSet.findMany.mock.calls[1][0].where.id).toEqual({ in: ["b"] });
  });

  it("grants nothing from an archived role, whatever the token says", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([set("a", 4, ["procurement.budgets.view"], new Date())]);
    expect(await permissionsForHeldSets("org-1", [["a", 4]])).toEqual([]);
  });

  it("answers empty without a query for no roles or no organisation", async () => {
    expect(await permissionsForHeldSets("org-1", [])).toEqual([]);
    expect(await permissionsForHeldSets(null, [["a", 1]])).toEqual([]);
    expect(await permissionsForHeldSets("org-1", undefined)).toEqual([]);
    expect(mockDb.permissionSet.findMany).not.toHaveBeenCalled();
  });

  it("never throws: a failed read logs and answers with what it has", async () => {
    mockDb.permissionSet.findMany.mockRejectedValue(new Error("pool timeout"));
    expect(await permissionsForHeldSets("org-1", [["a", 1]])).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "auth:permissions-resolve-failed" }));
  });
});

describe("cookie size", () => {
  it("a token holding many roles stays small, where the old key list did not", () => {
    const base = { id: "c".repeat(25), role: "MEMBER", organizationId: "o".repeat(25), firstName: "Firstname", lastName: "Lastname" };
    const heldRoles = Array.from({ length: 6 }, (_, i) => [`cmrole${i}${"x".repeat(18)}`, 12] as const);
    const keys = Array.from({ length: 20 }, (_, i) => `procurement.suppliers.financials.view.${i}`);
    expect(estimatedCookieBytes({ ...base, heldRoles })).toBeLessThan(estimatedCookieBytes({ ...base, procurementPermissions: keys }));
    expect(estimatedCookieBytes({ ...base, heldRoles })).toBeLessThan(COOKIE_WARN_BYTES);
  });
});
