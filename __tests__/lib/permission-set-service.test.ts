/**
 * The seed-once rule and the union read, both of which fail silently if wrong:
 * a re-seed quietly undoes an admin's archive, and a union that ignores
 * `archivedAt` keeps granting access somebody withdrew.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.mock` factories are hoisted above every top-level const in the file, so
// the mock must be hoisted WITH them. A plain `const` here is read before it
// exists and the whole suite fails to load rather than failing an assertion.
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    permissionSet: { findMany: vi.fn(), create: vi.fn() },
    userPermissionSet: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  // The real wrapper runs the callback against a tx client; the fake hands back
  // the same mock so the creates are observable.
  tenantTransaction: (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureStarterPermissionSets, readUserPermissions } from "@/lib/permissions/permission-set-service";
import { STARTER_ROLES, isPermissionKey } from "@/lib/permissions/catalogue";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureStarterPermissionSets", () => {
  it("seeds the four starter roles when the organisation holds none", async () => {
    mockDb.permissionSet.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x" }]);
    mockDb.permissionSet.create.mockResolvedValue({ id: "x" });

    await ensureStarterPermissionSets("org-1");

    expect(mockDb.permissionSet.create).toHaveBeenCalledTimes(STARTER_ROLES.length);
    const names = mockDb.permissionSet.create.mock.calls.map((c) => c[0].data.name);
    expect(names).toEqual(STARTER_ROLES.map((r) => r.name));
  });

  it("stamps the organisation on the CHILD rows too, which a nested create does not inherit", async () => {
    mockDb.permissionSet.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.permissionSet.create.mockResolvedValue({ id: "x" });

    await ensureStarterPermissionSets("org-1");

    for (const call of mockDb.permissionSet.create.mock.calls) {
      for (const child of call[0].data.permissions.create) {
        // Without this the flat RLS policy has nothing to match on.
        expect(child.organizationId).toBe("org-1");
        expect(isPermissionKey(child.permission)).toBe(true);
      }
    }
  });

  it("never re-seeds an organisation that already holds a role", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "a", name: "PO Author", description: null, version: 1, archivedAt: null, permissions: [] },
    ]);

    await ensureStarterPermissionSets("org-1");

    expect(mockDb.permissionSet.create).not.toHaveBeenCalled();
  });

  it("never re-seeds when every role has been ARCHIVED, because that was a decision", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "a", name: "PO Author", description: null, version: 1, archivedAt: new Date(), permissions: [] },
    ]);

    await ensureStarterPermissionSets("org-1");

    expect(mockDb.permissionSet.create).not.toHaveBeenCalled();
  });

  it("returns the winner's rows when a concurrent seeder took the names", async () => {
    const winner = [
      { id: "w", name: "PO Author", description: null, version: 1, archivedAt: null, permissions: [] },
    ];
    mockDb.permissionSet.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(winner);
    mockDb.permissionSet.create.mockRejectedValue(new Error("Unique constraint failed"));

    const result = await ensureStarterPermissionSets("org-1");

    // Never an empty list, which downstream would read as "no roles exist".
    expect(result).toEqual(winner);
  });
});

describe("readUserPermissions", () => {
  it("unions the keys across every role the person holds, deduplicated", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      { permissionSet: { permissions: [{ permission: "procurement.budgets.view" }, { permission: "procurement.requests.create" }] } },
      { permissionSet: { permissions: [{ permission: "procurement.budgets.view" }, { permission: "procurement.orders.view" }] } },
    ]);

    const keys = await readUserPermissions("org-1", "user-1");

    expect(new Set(keys)).toEqual(
      new Set(["procurement.budgets.view", "procurement.requests.create", "procurement.orders.view"]),
    );
    expect(keys.length).toBe(3);
  });

  it("asks the database to exclude archived roles, so withdrawing access bites here", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([]);

    await readUserPermissions("org-1", "user-1");

    const where = mockDb.userPermissionSet.findMany.mock.calls[0][0].where;
    expect(where.permissionSet).toEqual({ archivedAt: null });
    expect(where.organizationId).toBe("org-1");
    expect(where.userId).toBe("user-1");
  });

  it("drops a stored key this build no longer enforces", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      { permissionSet: { permissions: [{ permission: "procurement.budgets.reopen" }, { permission: "procurement.budgets.view" }] } },
    ]);

    const keys = await readUserPermissions("org-1", "user-1");

    // D15 folded reopen into edit; a surviving row must not satisfy a future check.
    expect(keys).toEqual(["procurement.budgets.view"]);
  });
});
