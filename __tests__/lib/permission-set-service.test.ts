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
    permissionSet: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    permissionSetGrant: { deleteMany: vi.fn(), createMany: vi.fn() },
    userPermissionSet: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
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

// Phase 2 will make event-bound keys live one domain at a time; until then no
// live key takes a scope, so the SCOPE_REQUIRED rule is pinned by treating one
// event-bound key as live here. Everything else is the real catalogue.
vi.mock("@/lib/permissions/catalogue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions/catalogue")>();
  return { ...actual, isLivePermissionKey: (k: string) => actual.isLivePermissionKey(k) || k === "registrations.checkin" };
});

import {
  createPermissionSet,
  ensureStarterPermissionSets,
  ensureSystemPermissionSets,
  readUserGrants,
  readUserPermissions,
  setPermissionSetArchived,
  setUserPermissionSets,
  systemRoleRowKey,
  updatePermissionSet,
} from "@/lib/permissions/permission-set-service";
import { STARTER_ROLES, isPermissionKey } from "@/lib/permissions/catalogue";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@/lib/permissions/system-roles";

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

const SET = { id: "s1", name: "PO Author", description: null, key: null, isSystem: false, version: 1, archivedAt: null, permissions: [] };
const SYSTEM_SET = { ...SET, id: "sys", name: "Admin", key: "admin", isSystem: true };

describe("grants with a scope (Phase 1 slice 2)", () => {
  beforeEach(() => {
    mockDb.permissionSet.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...SET, ...args.data }));
    mockDb.auditLog.create.mockResolvedValue({});
  });

  it("stores a bare key with no scope, as the Roles tab sends it today", async () => {
    const r = await createPermissionSet({ organizationId: "org-1", actorUserId: "u", name: "R", permissions: ["procurement.budgets.view"] });
    expect(r.ok).toBe(true);
    expect(mockDb.permissionSet.create.mock.calls[0][0].data.permissions.create).toEqual([
      { organizationId: "org-1", permission: "procurement.budgets.view", scope: null },
    ]);
  });

  it("refuses a scope on an organisation-wide key", async () => {
    const r = await createPermissionSet({
      organizationId: "org-1",
      actorUserId: "u",
      name: "R",
      permissions: [{ permission: "procurement.budgets.view", scope: "ALL" }],
    });
    expect(r).toMatchObject({ ok: false, code: "SCOPE_NOT_ALLOWED" });
    expect(mockDb.permissionSet.create).not.toHaveBeenCalled();
  });

  it("requires a scope on an event-bound key, and stores it", async () => {
    const missing = await createPermissionSet({ organizationId: "org-1", actorUserId: "u", name: "R", permissions: ["registrations.checkin"] });
    expect(missing).toMatchObject({ ok: false, code: "SCOPE_REQUIRED" });
    const bad = await createPermissionSet({
      organizationId: "org-1",
      actorUserId: "u",
      name: "R",
      permissions: [{ permission: "registrations.checkin", scope: "EVERYWHERE" as never }],
    });
    expect(bad).toMatchObject({ ok: false, code: "SCOPE_REQUIRED" });
    const r = await createPermissionSet({
      organizationId: "org-1",
      actorUserId: "u",
      name: "R",
      permissions: [{ permission: "registrations.checkin", scope: "ASSIGNED" }],
    });
    expect(r.ok).toBe(true);
    expect(mockDb.permissionSet.create.mock.calls[0][0].data.permissions.create).toEqual([
      { organizationId: "org-1", permission: "registrations.checkin", scope: "ASSIGNED" },
    ]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.permissions).toEqual(["registrations.checkin@ASSIGNED"]);
  });

  it("still refuses a key that is not live, before any scope rule", async () => {
    const r = await createPermissionSet({
      organizationId: "org-1",
      actorUserId: "u",
      name: "R",
      permissions: [{ permission: "events.delete", scope: "ALL" }],
    });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_PERMISSION" });
  });
});

describe("system roles are rows for identity only", () => {
  beforeEach(() => {
    mockDb.auditLog.create.mockResolvedValue({});
  });

  it("cannot be edited", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue(SYSTEM_SET);
    const r = await updatePermissionSet({ organizationId: "org-1", actorUserId: "u", permissionSetId: "sys", expectedVersion: 1, name: "X" });
    expect(r).toMatchObject({ ok: false, code: "SYSTEM_ROLE" });
    expect(mockDb.permissionSet.updateMany).not.toHaveBeenCalled();
  });

  it("cannot be archived", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue({ id: "sys", name: "Admin", isSystem: true, archivedAt: null, _count: { holders: 0 } });
    const r = await setPermissionSetArchived({ organizationId: "org-1", actorUserId: "u", permissionSetId: "sys", archived: true });
    expect(r).toMatchObject({ ok: false, code: "SYSTEM_ROLE" });
    expect(mockDb.permissionSet.updateMany).not.toHaveBeenCalled();
  });

  it("cannot be assigned to a person", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([{ id: "sys", name: "Admin", isSystem: true, archivedAt: null, permissions: [] }]);
    const r = await setUserPermissionSets({ organizationId: "org-1", actorUserId: "u", userId: "p", permissionSetIds: ["sys"] });
    expect(r).toMatchObject({ ok: false, code: "SYSTEM_ROLE" });
    expect(mockDb.userPermissionSet.deleteMany).not.toHaveBeenCalled();
  });

  it("are left out of the list the Roles tab reads, so a seeded row changes nothing a user sees", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([SET]);
    await ensureStarterPermissionSets("org-1");
    expect(mockDb.permissionSet.findMany.mock.calls[0][0].where).toEqual({ organizationId: "org-1", isSystem: false });
  });

  it("are seeded by an upsert per system role: idempotent, no grants, keyed by organisation and key", async () => {
    mockDb.permissionSet.upsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({ ...SET, ...args.create, permissions: [] }));
    const rows = await ensureSystemPermissionSets("org-1");
    expect(rows).toHaveLength(SYSTEM_ROLE_KEYS.length);
    const calls = mockDb.permissionSet.upsert.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.where)).toEqual(SYSTEM_ROLE_KEYS.map((k) => ({ organizationId_key: { organizationId: "org-1", key: systemRoleRowKey(k) } })));
    for (const [i, c] of calls.entries()) {
      expect(c.create).toMatchObject({ organizationId: "org-1", isSystem: true, name: SYSTEM_ROLES[SYSTEM_ROLE_KEYS[i]].name });
      expect(c.create.permissions).toBeUndefined();
      expect(c.update).toEqual({ name: SYSTEM_ROLES[SYSTEM_ROLE_KEYS[i]].name });
    }
    expect(systemRoleRowKey("SUPER_ADMIN")).toBe("super_admin");
  });
});

describe("readUserGrants: the union as pairs", () => {
  it("keeps the scope, drops non-live keys, and never collapses two scopes of one key", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      { permissionSet: { permissions: [{ permission: "procurement.budgets.view", scope: null }, { permission: "registrations.checkin", scope: "ASSIGNED" }] } },
      { permissionSet: { permissions: [{ permission: "procurement.budgets.view", scope: null }, { permission: "registrations.checkin", scope: "WEBINAR" }, { permission: "events.delete", scope: "ALL" }] } },
    ]);
    const grants = await readUserGrants("org-1", "u");
    expect(grants).toEqual([
      { permission: "procurement.budgets.view" },
      { permission: "registrations.checkin", scope: "ASSIGNED" },
      { permission: "registrations.checkin", scope: "WEBINAR" },
    ]);
  });
});
