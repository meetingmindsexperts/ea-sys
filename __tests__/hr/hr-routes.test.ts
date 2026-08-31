import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * Route-level tests for the HR API (review M14: there were none). The guards,
 * the org resolution and the status mapping run for real; the database and the
 * services behind the routes are mocked, so what is pinned is exactly what the
 * route decides: who gets in, and what HTTP status each service answer maps to.
 */

const { mockDb, mockAuth, rateLimit, seed, svc } = vi.hoisted(() => ({
  mockDb: {
    employee: { findMany: vi.fn(), findFirst: vi.fn() },
    publicHoliday: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    attendanceEntry: { count: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  rateLimit: vi.fn(),
  seed: { ensureLeaveCodes: vi.fn(), ensurePublicHolidays: vi.fn() },
  svc: {
    updateEmployee: vi.fn(),
    getOrgLeaveSummary: vi.fn(),
    getLeaveBalance: vi.fn(),
    setAttendance: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (b: unknown, i?: { status?: number; headers?: Record<string, string> }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: (k: string) => i?.headers?.[k] ?? null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (...args: unknown[]) => rateLimit(...args),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/hr/services/hr-seed-service", () => seed);
vi.mock("@/hr/services/employee-service", async (orig) => ({
  ...(await orig<typeof import("@/hr/services/employee-service")>()),
  updateEmployee: svc.updateEmployee,
}));
vi.mock("@/hr/services/leave-balance-service", async (orig) => ({
  ...(await orig<typeof import("@/hr/services/leave-balance-service")>()),
  getOrgLeaveSummary: svc.getOrgLeaveSummary,
  getLeaveBalance: svc.getLeaveBalance,
}));
vi.mock("@/hr/services/attendance-service", async (orig) => ({
  ...(await orig<typeof import("@/hr/services/attendance-service")>()),
  setAttendance: svc.setAttendance,
}));

import { GET as listEmployees } from "@/app/api/hr/employees/route";
import { PATCH as patchEmployee } from "@/app/api/hr/employees/[employeeId]/route";
import { POST as postHoliday } from "@/app/api/hr/holidays/route";
import { DELETE as deleteHoliday } from "@/app/api/hr/holidays/[holidayId]/route";
import { GET as getSummary } from "@/app/api/hr/summary/route";
import { GET as getBalance } from "@/app/api/hr/balances/[employeeId]/route";
import { PUT as putAttendance } from "@/app/api/hr/attendance/route";
import { LeaveYearNotHeldError } from "@/hr/services/leave-balance-service";

const ORIGINAL_FLAG = process.env.HR_MODULE_ENABLED;
afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.HR_MODULE_ENABLED;
  else process.env.HR_MODULE_ENABLED = ORIGINAL_FLAG;
});

const CUID = "cmth0oni60005y917w5lybinj";
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = (url: string, body?: unknown) =>
  ({ nextUrl: new URL(url), json: async () => body }) as never;
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HR_MODULE_ENABLED = "true";
  mockAuth.mockResolvedValue(session("HR_USER"));
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0, remaining: 299 });
  seed.ensureLeaveCodes.mockResolvedValue(0);
  seed.ensurePublicHolidays.mockResolvedValue(0);
  mockDb.employee.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("GET /api/hr/employees", () => {
  it("404s for EVERY role while the module is off, so an outsider learns nothing", async () => {
    delete process.env.HR_MODULE_ENABLED;
    for (const role of ["ADMIN", "ORGANIZER", "REGISTRANT"]) {
      mockAuth.mockResolvedValue(session(role));
      const res = await listEmployees(req("http://t/api/hr/employees"));
      expect(res.status, role).toBe(404);
    }
  });

  it("403s a non-HR role once the module is on, and admits HR_USER", async () => {
    mockAuth.mockResolvedValue(session("ORGANIZER"));
    expect((await listEmployees(req("http://t/api/hr/employees"))).status).toBe(403);

    mockAuth.mockResolvedValue(session("HR_USER"));
    const res = await listEmployees(req("http://t/api/hr/employees"));
    expect(res.status).toBe(200);
    // "Currently employed" is the last working day, never the status column.
    const where = mockDb.employee.findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe("org1");
    expect(where.status).toBeUndefined();
    expect(where.OR).toEqual([{ exitDate: null }, { exitDate: { gte: expect.any(Date) } }]);
  });

  it("401s with no session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await listEmployees(req("http://t/api/hr/employees"))).status).toBe(401);
  });
});

describe("PATCH /api/hr/employees/[id] maps the service's answers", () => {
  const cases: [string, number][] = [
    ["ENTRIES_OUTSIDE_WINDOW", 409],
    ["EXIT_DATE_REQUIRED", 400],
    ["LEAVER_STATUS_REQUIRED", 400],
    ["USER_NOT_IN_ORG", 400],
    ["USER_ALREADY_LINKED", 409],
    ["EMPLOYEE_NOT_FOUND", 404],
  ];
  for (const [code, status] of cases) {
    it(`${code} -> ${status}`, async () => {
      svc.updateEmployee.mockResolvedValue({ ok: false, code, message: "why" });
      const res = await patchEmployee(req("http://t/x", { name: "X" }), params({ employeeId: "e1" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    });
  }

  it("lets userId: null through to the service (unlink), and refuses a non-cuid", async () => {
    svc.updateEmployee.mockResolvedValue({ ok: true, employee: { id: "e1" } });
    const ok = await patchEmployee(req("http://t/x", { userId: null }), params({ employeeId: "e1" }));
    expect(ok.status).toBe(200);
    expect(svc.updateEmployee.mock.calls[0][0].patch).toEqual({ userId: null });

    const bad = await patchEmployee(req("http://t/x", { userId: "nope" }), params({ employeeId: "e1" }));
    expect(bad.status).toBe(400);
  });
});

describe("public holidays", () => {
  const body = { date: "2027-03-10", label: "Eid al-Fitr" };

  it("POST is rate-limited on the HR write bucket", async () => {
    rateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60, remaining: 0 });
    const res = await postHoliday(req("http://t/api/hr/holidays", body));
    expect(res.status).toBe(429);
    expect(rateLimit.mock.calls[0][0]).toMatchObject({ key: "hr-write:u1" });
  });

  it("POST creates, audits with the date and label, and answers 201", async () => {
    mockDb.publicHoliday.create.mockResolvedValue({ id: "h1", date: new Date("2027-03-10T00:00:00Z"), label: "Eid al-Fitr" });
    const res = await postHoliday(req("http://t/api/hr/holidays", body));
    expect(res.status).toBe(201);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "CREATE", entityType: "PublicHoliday", entityId: "h1",
      changes: { date: "2027-03-10", label: "Eid al-Fitr" },
    });
  });

  it("POST maps the unique clash to 409, never a 500", async () => {
    mockDb.publicHoliday.create.mockRejectedValue({ code: "P2002" });
    const res = await postHoliday(req("http://t/api/hr/holidays", body));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "DUPLICATE_DATE" });
  });

  it("DELETE 404s an unknown or foreign id", async () => {
    mockDb.publicHoliday.findFirst.mockResolvedValue(null);
    const res = await deleteHoliday(req("http://t/x"), params({ holidayId: "h9" }));
    expect(res.status).toBe(404);
    expect(mockDb.publicHoliday.deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE is refused while attendance is recorded on that date, naming the count", async () => {
    mockDb.publicHoliday.findFirst.mockResolvedValue({ id: "h1", date: new Date("2027-03-10T00:00:00Z"), label: "Eid al-Fitr" });
    mockDb.attendanceEntry.count.mockResolvedValue(2);
    const res = await deleteHoliday(req("http://t/x"), params({ holidayId: "h1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "HOLIDAY_IN_USE", count: 2 });
    expect(mockDb.publicHoliday.deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE removes through an org-bound write and audits the row", async () => {
    mockDb.publicHoliday.findFirst.mockResolvedValue({ id: "h1", date: new Date("2027-03-10T00:00:00Z"), label: "Eid al-Fitr" });
    mockDb.attendanceEntry.count.mockResolvedValue(0);
    mockDb.publicHoliday.deleteMany.mockResolvedValue({ count: 1 });
    const res = await deleteHoliday(req("http://t/x"), params({ holidayId: "h1" }));
    expect(res.status).toBe(200);
    expect(mockDb.publicHoliday.deleteMany).toHaveBeenCalledWith({ where: { id: "h1", organizationId: "org1" } });
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "DELETE", entityType: "PublicHoliday", changes: { date: "2027-03-10", label: "Eid al-Fitr" },
    });
  });
});

describe("?year= on the summary and balance routes", () => {
  it("rejects a malformed year", async () => {
    const res = await getSummary(req("http://t/api/hr/summary?year=abc"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_YEAR" });
  });

  it("answers 400 YEAR_NOT_HELD for a year the system holds nothing for", async () => {
    svc.getOrgLeaveSummary.mockRejectedValue(new LeaveYearNotHeldError(2025));
    const res = await getSummary(req("http://t/api/hr/summary?year=2025"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "YEAR_NOT_HELD" });

    svc.getLeaveBalance.mockRejectedValue(new LeaveYearNotHeldError(2025));
    const one = await getBalance(req("http://t/api/hr/balances/e1?year=2025"), params({ employeeId: "e1" }));
    expect(one.status).toBe(400);
    expect(await one.json()).toMatchObject({ code: "YEAR_NOT_HELD" });
  });

  it("still 500s on an unexpected failure", async () => {
    svc.getOrgLeaveSummary.mockRejectedValue(new Error("boom"));
    expect((await getSummary(req("http://t/api/hr/summary"))).status).toBe(500);
  });
});

describe("PUT /api/hr/attendance", () => {
  it("maps a transaction timeout to 503, so the caller knows nothing was written", async () => {
    svc.setAttendance.mockResolvedValue({ ok: false, code: "WRITE_TIMED_OUT", message: "too long" });
    const res = await putAttendance(
      req("http://t/api/hr/attendance", { employeeId: CUID, from: "2026-01-01", to: "2026-12-31", code: "WFH" }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "WRITE_TIMED_OUT" });
  });
});
