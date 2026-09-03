/**
 * /api/activity — the HR scope split (Sep 3, 2026).
 *
 * THE GAP THIS CLOSES. The HR services write to the shared AuditLog. This
 * route is gated ADMIN + SUPER_ADMIN; HR is gated SUPER_ADMIN plus the
 * per-person `hrAccess` grant, and ADMIN alone is NOT enough (owner, Aug 31).
 * Before the split, an admin with no grant got every HR row in the default
 * feed and, through the raw JSON, every attendance blob: employee id, leave
 * code, date range. The default query must EXCLUDE HR rows; `?scope=hr` must
 * INCLUDE only them behind the real `canViewHr`.
 *
 * `canViewHr` and `HR_AUDIT_ENTITY_TYPES` are REAL here: the predicate is the
 * thing under test, so mocking it would test the mock. The mutation that
 * matters is reverting the route's `notIn` to nothing; the default-scope
 * assertions below fail on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HR_AUDIT_ENTITY_TYPES } from "@/lib/hr-visibility";

const { mockDb, mockAuth, mockLogger, mockHrEnabled } = vi.hoisted(() => ({
  mockDb: {
    auditLog: { findMany: vi.fn() },
    employee: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockHrEnabled: vi.fn(() => true),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/module-flags", () => ({ isHrModuleEnabled: () => mockHrEnabled() }));

import { GET } from "@/app/api/activity/route";

const HR = [...HR_AUDIT_ENTITY_TYPES];

const req = (qs = "") => new Request(`http://localhost/api/activity${qs}`);

const user = (role: string, hrAccess = false) => ({
  user: { id: "u1", role, organizationId: "org1", hrAccess },
});

const whereOf = () =>
  (mockDb.auditLog.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

beforeEach(() => {
  vi.clearAllMocks();
  mockHrEnabled.mockReturnValue(true);
  mockDb.auditLog.findMany.mockResolvedValue([]);
  mockDb.employee.findMany.mockResolvedValue([]);
});

describe("GET /api/activity — default scope excludes HR rows", () => {
  it("401 with no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("403 for a role outside ADMIN/SUPER_ADMIN (unchanged)", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("an ADMIN without the HR grant never receives HR rows in the default feed", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(whereOf()).toMatchObject({
      organizationId: "org1",
      entityType: { notIn: HR },
    });
  });

  it("SUPER_ADMIN also gets the exclusion by default: the HR tab is where HR lives", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req());
    expect(whereOf().entityType).toEqual({ notIn: HR });
  });

  it("an explicit entityType filter narrows WITHIN the exclusion; it cannot lift it", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    await GET(req("?entityType=Employee"));
    // Both predicates present: {equals: Employee, notIn: [...Employee...]} is
    // the empty set, which is exactly right.
    expect(whereOf().entityType).toEqual({ notIn: HR, equals: "Employee" });
  });

  it("a non-HR entityType filter still works", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    await GET(req("?entityType=Registration&eventId=ev1"));
    expect(whereOf()).toMatchObject({
      eventId: "ev1",
      entityType: { notIn: HR, equals: "Registration" },
    });
  });

  it("does not attach subjectName in the default scope and never touches Employee", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    mockDb.auditLog.findMany.mockResolvedValue([
      { id: "a1", action: "UPDATE", entityType: "Registration", entityId: "r1", changes: {}, createdAt: new Date(), user: null, event: null },
    ]);
    const res = await GET(req());
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect("subjectName" in body[0]).toBe(false);
    expect(mockDb.employee.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/activity?scope=hr — the two HR walls", () => {
  it("403 + logged for an ADMIN without the per-person grant, and no query runs", async () => {
    mockAuth.mockResolvedValue(user("ADMIN", false));
    const res = await GET(req("?scope=hr"));
    expect(res.status).toBe(403);
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "activity:hr-scope-forbidden", role: "ADMIN", userId: "u1" }),
    );
  });

  it("200 for an ADMIN holding the grant, querying ONLY the HR types", async () => {
    mockAuth.mockResolvedValue(user("ADMIN", true));
    const res = await GET(req("?scope=hr"));
    expect(res.status).toBe(200);
    expect(whereOf()).toMatchObject({ organizationId: "org1", entityType: { in: HR } });
  });

  it("200 for SUPER_ADMIN (self-sufficient role)", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    const res = await GET(req("?scope=hr"));
    expect(res.status).toBe(200);
    expect(whereOf().entityType).toEqual({ in: HR });
  });

  it("404 + logged when the module is switched off, even for SUPER_ADMIN", async () => {
    mockHrEnabled.mockReturnValue(false);
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    const res = await GET(req("?scope=hr"));
    expect(res.status).toBe(404);
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "activity:hr-module-disabled" }),
    );
  });

  it("an entityType filter inside the HR scope stays inside it", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req("?scope=hr&entityType=AttendanceEntry"));
    expect(whereOf().entityType).toEqual({ in: HR, equals: "AttendanceEntry" });
  });

  it("a bogus scope is refused, never widened to the default", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    const res = await GET(req("?scope=everything"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_SCOPE" });
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "activity:invalid-scope", scope: "everything" }),
    );
  });

  it("scope=changes is the explicit spelling of the default", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET(req("?scope=changes"));
    expect(res.status).toBe(200);
    expect(whereOf().entityType).toEqual({ notIn: HR });
  });
});

describe("GET /api/activity?scope=hr — subject-name resolution", () => {
  it("resolves employee names from every id shape, org-bound, in one query", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    const now = new Date();
    mockDb.auditLog.findMany.mockResolvedValue([
      { id: "a1", action: "UPDATE", entityType: "Employee", entityId: "e1", changes: { changed: {} }, createdAt: now, user: null, event: null },
      { id: "a2", action: "UPDATE", entityType: "AttendanceEntry", entityId: "employee:e2", changes: { employeeId: "e2", code: "SL" }, createdAt: now, user: null, event: null },
      { id: "a3", action: "CREATE", entityType: "AttendanceRule", entityId: "r1", changes: { scope: "EMPLOYEE", employeeId: "e3" }, createdAt: now, user: null, event: null },
      { id: "a4", action: "UPDATE", entityType: "LeaveGrant", entityId: "year:2027", changes: {}, createdAt: now, user: null, event: null },
    ]);
    mockDb.employee.findMany.mockResolvedValue([
      { id: "e1", name: "Dina Ortiz", empCode: "EMP001" },
      { id: "e2", name: "Muthu K", empCode: "EMP002" },
      // e3 deliberately missing: a deleted employee resolves to null, not a crash
    ]);

    const res = await GET(req("?scope=hr"));
    const body = (await res.json()) as Array<{ id: string; subjectName: string | null }>;

    expect(mockDb.employee.findMany).toHaveBeenCalledTimes(1);
    const arg = mockDb.employee.findMany.mock.calls[0][0] as { where: { id: { in: string[] }; organizationId: string } };
    expect(arg.where.organizationId).toBe("org1");
    expect([...arg.where.id.in].sort()).toEqual(["e1", "e2", "e3"]);

    expect(body.map((r) => [r.id, r.subjectName])).toEqual([
      ["a1", "Dina Ortiz"],
      ["a2", "Muthu K"],
      ["a3", null],
      ["a4", null],
    ]);
  });

  it("skips the employee query entirely when no row names an employee", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    mockDb.auditLog.findMany.mockResolvedValue([
      { id: "a4", action: "UPDATE", entityType: "LeaveGrant", entityId: "year:2027", changes: {}, createdAt: new Date(), user: null, event: null },
    ]);
    await GET(req("?scope=hr"));
    expect(mockDb.employee.findMany).not.toHaveBeenCalled();
  });
});
