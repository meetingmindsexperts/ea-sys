/**
 * Managing custom roles: the refusals that matter.
 *
 * The valuable pins here are the ones that fail SILENTLY if wrong — an unknown
 * permission quietly dropped (the role grants less than the screen showed), a
 * role edit that breaks the separation for people already holding it, and an
 * assignment that is not truly replace-all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted WITH the vi.mock factories: they run above every plain top-level
// const, so a bare `const` here is read before it exists and the whole suite
// fails to load rather than failing an assertion.
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    permissionSet: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    permissionSetGrant: { deleteMany: vi.fn(), createMany: vi.fn() },
    userPermissionSet: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), groupBy: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createPermissionSet,
  listPermissionSets,
  setPermissionSetArchived,
  setUserPermissionSets,
  updatePermissionSet,
  readPermissionSetHolderCounts,
} from "@/lib/permissions/permission-set-service";

const ORG = "org-1";
const ACTOR = "actor-1";
const base = { organizationId: ORG, actorUserId: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.userPermissionSet.findMany.mockResolvedValue([]);
});

describe("readPermissionSetHolderCounts", () => {
  it("counts live roles per person and EXCLUDES archived ones", async () => {
    mockDb.userPermissionSet.groupBy.mockResolvedValue([
      { userId: "u1", _count: { _all: 2 } },
      { userId: "u2", _count: { _all: 1 } },
    ]);
    const counts = await readPermissionSetHolderCounts("org1");
    expect(counts).toEqual({ u1: 2, u2: 1 });
    // Archiving is how an administrator takes a role out of use; counting one
    // would keep its former holders looking granted.
    const where = mockDb.userPermissionSet.groupBy.mock.calls[0][0].where;
    expect(where).toEqual({ organizationId: "org1", permissionSet: { archivedAt: null } });
  });
  it("leaves somebody holding none ABSENT rather than present as 0", async () => {
    mockDb.userPermissionSet.groupBy.mockResolvedValue([]);
    expect(await readPermissionSetHolderCounts("org1")).toEqual({});
  });
});

describe("createPermissionSet", () => {
  it("refuses an unknown permission instead of silently dropping it", async () => {
    // Dropping it would store a role that grants less than the screen showed,
    // which is the one failure an administrator cannot notice.
    const result = await createPermissionSet({
      ...base,
      name: "Odd",
      permissions: ["procurement.budgets.view", "procurement.budgets.teleport"],
    });
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_PERMISSION" });
    expect(mockDb.permissionSet.create).not.toHaveBeenCalled();
  });

  it("refuses a role with no permissions", async () => {
    const result = await createPermissionSet({ ...base, name: "Empty", permissions: [] });
    expect(result).toMatchObject({ ok: false, code: "NO_PERMISSIONS" });
  });

  it("refuses a name that is only whitespace", async () => {
    const result = await createPermissionSet({ ...base, name: "   ", permissions: ["procurement.budgets.view"] });
    expect(result).toMatchObject({ ok: false, code: "NAME_REQUIRED" });
  });

  it("refuses a role that breaks the separation on its own", async () => {
    const result = await createPermissionSet({
      ...base,
      name: "Both",
      permissions: ["procurement.budgets.signoff", "procurement.approvals.decide"],
    });
    expect(result).toMatchObject({ ok: false, code: "SEPARATION_CONFLICT" });
    expect(mockDb.permissionSet.create).not.toHaveBeenCalled();
  });

  it("stamps the organisation on the CHILD grants, which a nested create does not inherit", async () => {
    mockDb.permissionSet.create.mockResolvedValue({ id: "s1", permissions: [] });
    await createPermissionSet({ ...base, name: "Reader", permissions: ["procurement.budgets.view"] });
    const data = mockDb.permissionSet.create.mock.calls[0][0].data;
    // Without this the flat RLS policy has nothing to match on.
    expect(data.permissions.create[0].organizationId).toBe(ORG);
  });

  it("maps a duplicate name onto its own code rather than a 500", async () => {
    mockDb.permissionSet.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const result = await createPermissionSet({ ...base, name: "PO Author", permissions: ["procurement.budgets.view"] });
    expect(result).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
  });

  it("deduplicates a key sent twice", async () => {
    mockDb.permissionSet.create.mockResolvedValue({ id: "s1", permissions: [] });
    await createPermissionSet({
      ...base,
      name: "Reader",
      permissions: ["procurement.budgets.view", "procurement.budgets.view"],
    });
    expect(mockDb.permissionSet.create.mock.calls[0][0].data.permissions.create).toHaveLength(1);
  });
});

describe("updatePermissionSet", () => {
  const current = {
    id: "s1",
    name: "PO Approver",
    description: null,
    version: 3,
    archivedAt: null,
    permissions: [{ permission: "procurement.approvals.decide" }],
  };

  it("refuses a stale edit before touching anything", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue(current);
    const result = await updatePermissionSet({ ...base, permissionSetId: "s1", expectedVersion: 2, name: "x" });
    expect(result).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(mockDb.permissionSet.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an edit that would break the separation for someone already holding it, and NAMES them", async () => {
    // The whole reason a role edit is not a local change: adding a tick here
    // changes what every holder can do, and two individually-sensible roles
    // combine into one person approving their own purchase.
    mockDb.permissionSet.findFirst.mockResolvedValue(current);
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      {
        user: {
          firstName: "Muthukaruppan",
          lastName: "Chockalingam",
          email: "m@example.com",
          procurementApproveUnlimited: false,
          procurementRequest: false,
          // Holds the legacy settle switch, so gaining "approve" is the
          // forbidden pair even though no role of theirs carries sign-off.
          procurementSettle: true,
          permissionSets: [],
        },
      },
    ]);

    const result = await updatePermissionSet({
      ...base,
      permissionSetId: "s1",
      expectedVersion: 3,
      permissions: ["procurement.approvals.decide"],
    });

    expect(result).toMatchObject({ ok: false, code: "SEPARATION_CONFLICT" });
    expect((result as { message: string }).message).toContain("Muthukaruppan Chockalingam");
    expect(mockDb.permissionSet.updateMany).not.toHaveBeenCalled();
  });

  it("judges a holder on the union they would END UP with, not on this role alone", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue(current);
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      {
        user: {
          firstName: "Ada",
          lastName: "L",
          email: "a@example.com",
          procurementApproveUnlimited: false,
          procurementRequest: false,
          procurementSettle: false,
          permissionSets: [
            // Another role of theirs carries sign-off; this edit adds deciding.
            { permissionSetId: "other", permissionSet: { permissions: [{ permission: "procurement.budgets.signoff" }] } },
          ],
        },
      },
    ]);

    const result = await updatePermissionSet({
      ...base,
      permissionSetId: "s1",
      expectedVersion: 3,
      permissions: ["procurement.approvals.decide"],
    });

    expect(result).toMatchObject({ ok: false, code: "SEPARATION_CONFLICT" });
  });

  it("ignores THIS role's stored keys when recomputing a holder's union", async () => {
    // The holder's nested rows still carry the OLD permissions for this set;
    // counting them would refuse an edit that actually REMOVES the conflict.
    mockDb.permissionSet.findFirst.mockResolvedValue({
      ...current,
      permissions: [{ permission: "procurement.approvals.decide" }, { permission: "procurement.budgets.signoff" }],
    });
    mockDb.userPermissionSet.findMany.mockResolvedValue([
      {
        user: {
          firstName: "Ada",
          lastName: "L",
          email: "a@example.com",
          procurementApproveUnlimited: false,
          procurementRequest: false,
          procurementSettle: false,
          permissionSets: [
            {
              permissionSetId: "s1",
              permissionSet: {
                permissions: [{ permission: "procurement.approvals.decide" }, { permission: "procurement.budgets.signoff" }],
              },
            },
          ],
        },
      },
    ]);
    mockDb.permissionSet.updateMany.mockResolvedValue({ count: 1 });
    mockDb.permissionSet.findFirstOrThrow.mockResolvedValue({ ...current, version: 4 });

    const result = await updatePermissionSet({
      ...base,
      permissionSetId: "s1",
      expectedVersion: 3,
      permissions: ["procurement.approvals.decide"],
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("replaces the grants inside the same transaction as the claim", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue(current);
    mockDb.permissionSet.updateMany.mockResolvedValue({ count: 1 });
    mockDb.permissionSet.findFirstOrThrow.mockResolvedValue({ ...current, version: 4 });

    await updatePermissionSet({
      ...base,
      permissionSetId: "s1",
      expectedVersion: 3,
      permissions: ["procurement.budgets.view"],
    });

    expect(mockDb.permissionSetGrant.deleteMany).toHaveBeenCalledWith({ where: { permissionSetId: "s1" } });
    expect(mockDb.permissionSetGrant.createMany).toHaveBeenCalled();
    // The lock is the version, so a concurrent edit cannot also commit.
    expect(mockDb.permissionSet.updateMany.mock.calls[0][0].where.version).toBe(3);
  });

  it("returns STALE_WRITE and writes no grants when the claim is lost", async () => {
    mockDb.permissionSet.findFirst.mockResolvedValue(current);
    mockDb.permissionSet.updateMany.mockResolvedValue({ count: 0 });

    const result = await updatePermissionSet({
      ...base,
      permissionSetId: "s1",
      expectedVersion: 3,
      permissions: ["procurement.budgets.view"],
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(mockDb.permissionSetGrant.createMany).not.toHaveBeenCalled();
  });
});

describe("setPermissionSetArchived", () => {
  it("archives a role people still hold, and reports how many were affected", async () => {
    // Archiving IS how access is withdrawn from everyone at once, so holders
    // must not block it — the count is what the screen warns with.
    mockDb.permissionSet.findFirst.mockResolvedValue({
      id: "s1",
      name: "PO Author",
      archivedAt: null,
      _count: { holders: 4 },
    });
    mockDb.permissionSet.updateMany.mockResolvedValue({ count: 1 });
    mockDb.permissionSet.findFirstOrThrow.mockResolvedValue({
      id: "s1",
      name: "PO Author",
      description: null,
      version: 2,
      archivedAt: new Date(),
      permissions: [],
    });

    const result = await setPermissionSetArchived({ ...base, permissionSetId: "s1", archived: true });

    expect(result).toMatchObject({ ok: true, holderCount: 4 });
  });
});

describe("setUserPermissionSets", () => {
  const person = {
    firstName: "Ada",
    lastName: "L",
    email: "a@example.com",
    procurementApproveUnlimited: false,
    procurementRequest: false,
    procurementSettle: false,
  };

  it("refuses an archived role rather than tagging somebody with dead access", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "s1", name: "Old", archivedAt: new Date(), permissions: [] },
    ]);
    const result = await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: ["s1"] });
    expect(result).toMatchObject({ ok: false, code: "ARCHIVED" });
    expect(mockDb.userPermissionSet.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an id that is not this organisation's", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([]);
    const result = await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: ["someone-elses"] });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses the combination against the person's LEGACY switch", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "s1", name: "PO Approver", archivedAt: null, permissions: [{ permission: "procurement.approvals.decide" }] },
    ]);
    mockDb.user.findFirst.mockResolvedValue({ ...person, procurementSettle: true });

    const result = await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: ["s1"] });

    expect(result).toMatchObject({ ok: false, code: "SEPARATION_CONFLICT" });
    expect(mockDb.userPermissionSet.deleteMany).not.toHaveBeenCalled();
  });

  it("is replace-all: clears first, then writes exactly what was sent", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "s1", name: "Requester", archivedAt: null, permissions: [{ permission: "procurement.requests.create" }] },
    ]);
    mockDb.user.findFirst.mockResolvedValue(person);
    mockDb.userPermissionSet.findMany.mockResolvedValue([{ permissionSetId: "old" }]);

    const result = await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: ["s1"] });

    expect(result).toMatchObject({ ok: true, permissionSetIds: ["s1"] });
    expect(mockDb.userPermissionSet.deleteMany).toHaveBeenCalledWith({ where: { organizationId: ORG, userId: "u1" } });
    expect(mockDb.userPermissionSet.createMany.mock.calls[0][0].data).toEqual([
      { organizationId: ORG, userId: "u1", permissionSetId: "s1", assignedById: ACTOR },
    ]);
  });

  it("clearing every role is a real operation, not a no-op", async () => {
    mockDb.user.findFirst.mockResolvedValue(person);
    mockDb.userPermissionSet.findMany.mockResolvedValue([{ permissionSetId: "old" }]);

    const result = await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: [] });

    expect(result).toMatchObject({ ok: true });
    expect(mockDb.userPermissionSet.deleteMany).toHaveBeenCalled();
    expect(mockDb.userPermissionSet.createMany).not.toHaveBeenCalled();
  });

  it("records the change on the PERSON, where their access is looked up", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "s1", name: "Requester", archivedAt: null, permissions: [{ permission: "procurement.requests.create" }] },
    ]);
    mockDb.user.findFirst.mockResolvedValue(person);
    mockDb.userPermissionSet.findMany.mockResolvedValue([]);

    await setUserPermissionSets({ ...base, userId: "u1", permissionSetIds: ["s1"] });

    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.entityType).toBe("User");
    expect(audit.entityId).toBe("u1");
    expect(audit.changes.permissionSetsAdded).toEqual(["s1"]);
  });
});

describe("listPermissionSets", () => {
  it("surfaces the holder count, which is what archiving is judged on", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "s1", name: "A", description: null, version: 1, archivedAt: null, permissions: [], _count: { holders: 7 } },
    ]);
    const rows = await listPermissionSets(ORG);
    expect(rows[0]).toMatchObject({ id: "s1", holderCount: 7 });
    expect("_count" in rows[0]).toBe(false);
  });

  it("hides archived roles unless they are asked for", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([]);
    await listPermissionSets(ORG);
    expect(mockDb.permissionSet.findMany.mock.calls[0][0].where).toMatchObject({ archivedAt: null });
    await listPermissionSets(ORG, { includeArchived: true });
    expect(mockDb.permissionSet.findMany.mock.calls[1][0].where.archivedAt).toBeUndefined();
  });
});
