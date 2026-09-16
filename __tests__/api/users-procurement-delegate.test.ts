/**
 * PUT /api/organization/users/[userId]: the delegate who stands in after 48
 * hours (spec §8.3). Super admin only like every procurement grant, judged on
 * the resulting row: never themselves, never on the final approver (no
 * standby), only on someone who can approve, and the delegate must be an
 * active team member who can approve too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLogger, mockReadPermissions, mockRunWithTenant } = vi.hoisted(() => ({
  mockDb: {
    user: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // The route reads the person's custom-role permissions to judge the
  // separation rules on the RESULTING picture (plan §4).
  mockReadPermissions: vi.fn(),
  mockRunWithTenant: vi.fn((_org: string, fn: () => unknown) => fn()),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/auth-guards", () => ({ ASSIGNABLE_USER_ROLES: ["ADMIN", "ORGANIZER", "MEMBER"] }));
vi.mock("@/lib/module-flags", () => ({ isHrModuleEnabled: () => true, isProcurementModuleEnabled: () => true }));
vi.mock("@/lib/event-settings", () => ({ removeUserFromEventSettings: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: mockRunWithTenant }));
vi.mock("@/lib/permissions/permission-set-service", () => ({ readUserPermissions: mockReadPermissions }));
// `@/lib/permissions/separation` is deliberately REAL: it is pure, and it is
// the rule under test.

import { PUT } from "@/app/api/organization/users/[userId]/route";

const grants = (o: Record<string, unknown> = {}) => ({ procurementRequest: false, procurementApproveCeilingAed: null, procurementApproveUnlimited: false, procurementSettle: false, procurementDelegateUserId: null, deactivatedAt: null, ...o });
const ROWS: Record<string, Record<string, unknown>> = {
  lina: { id: "lina", role: "ADMIN", ...grants({ procurementApproveCeilingAed: "1000000" }) },
  sara: { id: "sara", role: "ADMIN", ...grants({ procurementApproveCeilingAed: "2000000" }) },
  medhat: { id: "medhat", role: "SUPER_ADMIN", ...grants({ procurementApproveUnlimited: true }) },
  owner: { id: "owner", role: "ORGANIZER", ...grants() },
  muthu: { id: "muthu", role: "MEMBER", ...grants({ procurementSettle: true }) },
  reg: { id: "reg", role: "REGISTRANT", ...grants({ procurementApproveCeilingAed: "5000" }) },
};

const put = (userId: string, body: Record<string, unknown>) =>
  PUT(new Request(`http://localhost/api/organization/users/${userId}`, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ userId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "boss", role: "SUPER_ADMIN", organizationId: "org1" } });
  mockDb.user.findFirst.mockImplementation(async (args: { where: { id: string } }) => ROWS[args.where.id] ?? null);
  mockDb.user.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "x", ...args.data }));
  mockDb.auditLog.create.mockResolvedValue({});
  mockReadPermissions.mockResolvedValue([]);
});

describe("setting a delegate", () => {
  it("stores a delegate who can approve, on a banded approver", async () => {
    const res = await put("lina", { procurementDelegateUserId: "sara" });
    expect(res.status).toBe(200);
    expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({ procurementDelegateUserId: "sara" });
    const lookup = mockDb.user.findFirst.mock.calls.find((c) => c[0].where.id === "sara")![0];
    expect(lookup.where).toEqual({ id: "sara", organizationId: "org1", deactivatedAt: null });
  });
  it("the final approver is a valid delegate", async () => {
    expect((await put("lina", { procurementDelegateUserId: "medhat" })).status).toBe(200);
  });
  it("is super admin only, like every procurement grant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "boss", role: "ADMIN", organizationId: "org1" } });
    expect((await put("lina", { procurementDelegateUserId: "sara" })).status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
  it("clearing it is always allowed", async () => {
    expect((await put("medhat", { procurementDelegateUserId: null })).status).toBe(200);
  });
});

describe("refusals, each logged with its code and nothing written", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["themselves", "lina", { procurementDelegateUserId: "lina" }, "DELEGATE_IS_SELF"],
    ["the final approver's delegate", "medhat", { procurementDelegateUserId: "lina" }, "FINAL_APPROVER_HAS_NO_DELEGATE"],
    ["someone who cannot approve having a delegate", "owner", { procurementDelegateUserId: "lina" }, "DELEGATE_NEEDS_AN_APPROVER"],
    ["a delegate who holds the settle grant", "lina", { procurementDelegateUserId: "muthu" }, "DELEGATE_CANNOT_APPROVE"],
    ["a delegate with no approval authority", "lina", { procurementDelegateUserId: "owner" }, "DELEGATE_CANNOT_APPROVE"],
    ["a delegate outside the organisation or deactivated", "lina", { procurementDelegateUserId: "ghost" }, "DELEGATE_NOT_FOUND"],
    ["a delegate who is not a team member", "lina", { procurementDelegateUserId: "reg" }, "DELEGATE_NOT_FOUND"],
  ];
  for (const [what, target, body, code] of cases) {
    it(`refuses ${what}`, async () => {
      const res = await put(target, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code });
      expect(mockDb.user.update).not.toHaveBeenCalled();
      if (code.startsWith("DELEGATE") || code === "FINAL_APPROVER_HAS_NO_DELEGATE") {
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/users:procurement-delegate-refused", code, targetUserId: target }));
      }
    });
  }
  it("making someone the final approver while a delegate is stored is refused, judged on the resulting row", async () => {
    ROWS.lina.procurementDelegateUserId = "sara";
    try {
      const res = await put("lina", { procurementApproveUnlimited: true, procurementApproveCeilingAed: null });
      expect(await res.json()).toMatchObject({ code: "FINAL_APPROVER_HAS_NO_DELEGATE" });
      expect((await put("lina", { procurementApproveUnlimited: true, procurementApproveCeilingAed: null, procurementDelegateUserId: null })).status).toBe(200);
    } finally {
      ROWS.lina.procurementDelegateUserId = null;
    }
  });
});

describe("a delegate gone stale", () => {
  it("is cleared, not refused, when a save only carries it along, and the save goes through", async () => {
    ROWS.lina.procurementDelegateUserId = "owner"; // owner can no longer approve
    try {
      const res = await put("lina", { procurementDelegateUserId: "owner" });
      expect(res.status).toBe(200);
      expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({ procurementDelegateUserId: null });
      expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/users:procurement-delegate-cleared", code: "DELEGATE_CANNOT_APPROVE", targetUserId: "lina" }));
      expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ procurementDelegateUserId: null, delegateCleared: true });
    } finally {
      ROWS.lina.procurementDelegateUserId = null;
    }
  });
  it("a deactivated delegate is cleared the same way when the save does not mention the delegate", async () => {
    ROWS.lina.procurementDelegateUserId = "ghost";
    try {
      const res = await put("lina", { procurementRequest: false });
      expect(res.status).toBe(200);
      expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({ procurementDelegateUserId: null });
    } finally {
      ROWS.lina.procurementDelegateUserId = null;
    }
  });
  it("a new delegate who cannot approve is still refused", async () => {
    ROWS.lina.procurementDelegateUserId = "sara";
    try {
      const res = await put("lina", { procurementDelegateUserId: "owner" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "DELEGATE_CANNOT_APPROVE" });
      expect(mockDb.user.update).not.toHaveBeenCalled();
    } finally {
      ROWS.lina.procurementDelegateUserId = null;
    }
  });
});

/**
 * A role change takes the person's module duties with it (owner, Sep 16 2026):
 * HR access and the four procurement grants are per-person authority that
 * nothing else revoked, so a demoted admin kept it until someone noticed.
 */
describe("a role change clears the module duties", () => {
  it("clears HR access and every procurement grant, logs it, and records what was held", async () => {
    const res = await put("muthu", { role: "ORGANIZER" });
    expect(res.status).toBe(200);
    expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({
      role: "ORGANIZER",
      hrAccess: false,
      procurementRequest: false,
      procurementApproveCeilingAed: null,
      procurementApproveUnlimited: false,
      procurementSettle: false,
      procurementDelegateUserId: null,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "organization/users:module-access-cleared-on-role-change", fromRole: "MEMBER", toRole: "ORGANIZER" }),
    );
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      moduleAccessCleared: true,
      previousProcurementSettle: true,
      previousRole: "MEMBER",
    });
  });

  it("clears on a promotion too, not only a demotion", async () => {
    // MEMBER holding the settle grant, promoted to ADMIN.
    const res = await put("muthu", { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({ role: "ADMIN", procurementSettle: false, hrAccess: false });
  });

  it("leaves the grants alone when the role is unchanged", async () => {
    const res = await put("lina", { role: "ADMIN", firstName: "Lina" });
    expect(res.status).toBe(200);
    const data = mockDb.user.update.mock.calls[0][0].data;
    expect(data.procurementApproveCeilingAed).toBeUndefined();
    expect(data.hrAccess).toBeUndefined();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.moduleAccessCleared).toBeUndefined();
  });

  it("a grant set in the same request as the role change still applies", async () => {
    const res = await put("muthu", { role: "ORGANIZER", procurementRequest: true });
    expect(res.status).toBe(200);
    expect(mockDb.user.update.mock.calls[0][0].data).toMatchObject({ procurementRequest: true, procurementSettle: false, hrAccess: false });
  });

  it("says nothing when the person held no module access", async () => {
    const res = await put("owner", { role: "MEMBER" });
    expect(res.status).toBe(200);
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({ msg: "organization/users:module-access-cleared-on-role-change" }));
    expect(mockDb.user.update.mock.calls[0][0].data.hrAccess).toBeUndefined();
  });
});

describe("the separation rules reach the custom roles too", () => {
  it("refuses promoting someone to final approver while a ROLE lets them raise requests", async () => {
    // The two older checks read only the legacy columns, so this combination
    // could be stored by going through the roles screen first and the limit
    // second. Judged on the resulting authority plus the roles already held.
    mockReadPermissions.mockResolvedValue(["procurement.requests.create"]);
    const res = await put("owner", { procurementApproveUnlimited: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FINAL_APPROVER_CANNOT_REQUEST" });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("A CEILING ALONE IS NOT AUTHORITY, so it does not conflict with a sign-off role", async () => {
    // D3 splits the two deliberately: `approvals.decide` says WHETHER somebody
    // decides, the AED amount says HOW MUCH. Deciding needs both, so a ceiling
    // on a person who holds no deciding permission grants nothing and is not
    // the forbidden pair. Refusing here would make a legitimate setup —
    // giving the finance signer an amount ahead of a future role — impossible.
    mockReadPermissions.mockResolvedValue(["procurement.budgets.signoff"]);
    expect((await put("owner", { procurementApproveCeilingAed: 50000 })).status).toBe(200);
  });

  it("refuses switching the old settle grant on for someone whose ROLE approves", async () => {
    // The pair that IS forbidden, and it is only reachable through this route:
    // the role was given on the Roles screen, the switch is flipped here.
    mockReadPermissions.mockResolvedValue(["procurement.approvals.decide"]);
    const res = await put("owner", { procurementSettle: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "SETTLE_CANNOT_DECIDE" });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("READS THE PERMISSIONS INSIDE A TENANT LANE", async () => {
    // `UserPermissionSet` is policied, so an unwrapped read returns zero rows
    // on the platform — which reads as "holds no role" and lets exactly the
    // combination above through. A security rule that fails open is worse
    // than none, so the lane is pinned here.
    await put("owner", { procurementApproveUnlimited: true });
    expect(mockRunWithTenant).toHaveBeenCalledWith("org1", expect.any(Function));
    expect(mockReadPermissions).toHaveBeenCalledWith("org1", "owner");
  });

  it("lets an ordinary grant change through when no role conflicts", async () => {
    mockReadPermissions.mockResolvedValue(["procurement.budgets.view"]);
    expect((await put("owner", { procurementRequest: true })).status).toBe(200);
  });
});
