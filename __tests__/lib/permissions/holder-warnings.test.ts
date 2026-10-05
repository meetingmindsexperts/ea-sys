/** The editor's warnings that need the database (custom roles plan §8.3). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { userPermissionSet: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { readHolderWarnings } from "@/lib/permissions/permission-set-service";

const holder = (over: Record<string, unknown> = {}, assignments = 0) => ({
  user: { id: "u", role: "MEMBER", hrAccess: false, procurementApproveCeilingAed: null, procurementApproveUnlimited: false, _count: { eventStaffAssignments: assignments }, ...over },
});

describe("holder warnings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("says nothing for a role nobody holds", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([]);
    expect(await readHolderWarnings("o", "s", [{ permission: "registrations.checkin", scope: "ASSIGNED" }])).toEqual([]);
  });

  it("flags assigned-events grants when no holder is assigned anywhere", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([holder(), holder({ id: "u2" })]);
    const w = await readHolderWarnings("o", "s", [{ permission: "registrations.checkin", scope: "ASSIGNED" }]);
    expect(w.map((x) => x.code)).toEqual(["ASSIGNED_NOBODY"]);
    mockDb.userPermissionSet.findMany.mockResolvedValue([holder({}, 1)]);
    expect(await readHolderWarnings("o", "s", [{ permission: "registrations.checkin", scope: "ASSIGNED" }])).toEqual([]);
  });

  it("counts the holders a person-grant key does nothing for", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue([holder(), holder({ id: "u2", procurementApproveCeilingAed: 5000 }), holder({ id: "u3" })]);
    const w = await readHolderWarnings("o", "s", ["procurement.approvals.decide"]);
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("PERSON_GRANT_MISSING");
    expect(w[0].message).toContain("2 of 3 people");
  });
});
