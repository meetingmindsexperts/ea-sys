import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Review M2, M3 and M6 (Aug 31 2026). The employee record's two invariants,
 * judged on the RESULTING row: status and last working day agree, and the
 * employment window never moves under recorded attendance. Plus the shape of
 * the write itself: org-bound in the WHERE, not only in the read before it.
 */

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    employee: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    attendanceEntry: { aggregate: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  checkEmploymentPair,
  createEmployee,
  employedOnWhere,
  updateEmployee,
} from "@/hr/services/employee-service";
import type { CalendarDate } from "@/hr/lib/hr-date";

const ORG = "org1";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const c = (s: string) => s as CalendarDate;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "e1", empCode: "EMP001", name: "Someone", department: null, jobTitle: null,
    joiningDate: d("2019-01-15"), exitDate: null, status: "ACTIVE",
    carryoverDays: 0, openingSickUsed: 0, openingCompOff: 0,
    annualEntitlementDays: null, seedLeaveYear: 2026, userId: null, notes: null,
    ...over,
  };
}
const noStranded = { _count: { _all: 0 }, _min: { date: null }, _max: { date: null } };
const base = { organizationId: ORG, actorUserId: "u1", employeeId: "e1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.employee.findFirst.mockResolvedValue(row());
  mockDb.employee.updateMany.mockResolvedValue({ count: 1 });
  mockDb.employee.create.mockImplementation(async ({ data }) => row(data));
  mockDb.attendanceEntry.aggregate.mockResolvedValue(noStranded);
  mockDb.user.findFirst.mockResolvedValue({ id: "u-in-org" });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("the status / last-working-day pair (M2)", () => {
  const today = c("2026-08-31");

  it("a leaver needs a last working day", () => {
    expect(checkEmploymentPair("RESIGNED", null, today)).toMatchObject({ ok: false, code: "EXIT_DATE_REQUIRED" });
    expect(checkEmploymentPair("TERMINATED", null, today)).toMatchObject({ ok: false, code: "EXIT_DATE_REQUIRED" });
  });

  it("an Active record cannot keep a last working day that has passed", () => {
    expect(checkEmploymentPair("ACTIVE", c("2026-08-30"), today)).toMatchObject({ ok: false, code: "LEAVER_STATUS_REQUIRED" });
  });

  it("serving notice is a real state: Active with a future date stays", () => {
    expect(checkEmploymentPair("ACTIVE", c("2026-09-30"), today)).toMatchObject({ ok: true });
    expect(checkEmploymentPair("ACTIVE", today, today)).toMatchObject({ ok: true });
    expect(checkEmploymentPair("ACTIVE", null, today)).toMatchObject({ ok: true });
    expect(checkEmploymentPair("RESIGNED", c("2026-06-30"), today)).toMatchObject({ ok: true });
  });

  it("judged on the RESULTING row: a status change alone is refused without a date", async () => {
    const res = await updateEmployee({ ...base, patch: { status: "RESIGNED" } });
    expect(res).toMatchObject({ ok: false, code: "EXIT_DATE_REQUIRED" });
    expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
  });

  it("the edit form's trap: clearing the date while the dropdown still says Resigned is refused", async () => {
    mockDb.employee.findFirst.mockResolvedValue(row({ exitDate: d("2026-06-30"), status: "RESIGNED" }));
    const res = await updateEmployee({ ...base, patch: { exitDate: null, status: "RESIGNED" } });
    expect(res).toMatchObject({ ok: false, code: "EXIT_DATE_REQUIRED" });
  });

  it("putting a leaver recorded by mistake back: clear the date AND set Active", async () => {
    mockDb.employee.findFirst.mockResolvedValue(row({ exitDate: d("2026-06-30"), status: "RESIGNED" }));
    const res = await updateEmployee({ ...base, patch: { exitDate: null, status: "ACTIVE" } });
    expect(res.ok).toBe(true);
    expect(mockDb.employee.updateMany.mock.calls[0][0].data).toMatchObject({ exitDate: null, status: "ACTIVE" });
  });

  it("a past last working day with the status left Active is refused", async () => {
    const res = await updateEmployee({ ...base, patch: { exitDate: c("2020-01-31") } });
    expect(res).toMatchObject({ ok: false, code: "LEAVER_STATUS_REQUIRED" });
  });

  it("create honours a status instead of dropping it, and checks the same pair", async () => {
    const leaver = await createEmployee({
      organizationId: ORG, actorUserId: "u1", source: "ui", empCode: "X1", name: "Left Already",
      joiningDate: c("2010-01-01"), exitDate: c("2015-12-31"), status: "RESIGNED",
    });
    expect(leaver.ok).toBe(true);
    expect(mockDb.employee.create.mock.calls[0][0].data.status).toBe("RESIGNED");

    const active = await createEmployee({
      organizationId: ORG, actorUserId: "u1", source: "ui", empCode: "X2", name: "New",
      joiningDate: c("2026-09-01"),
    });
    expect(active.ok).toBe(true);
    expect(mockDb.employee.create.mock.calls[1][0].data.status).toBe("ACTIVE");

    const undated = await createEmployee({
      organizationId: ORG, actorUserId: "u1", source: "ui", empCode: "X3", name: "Undated",
      joiningDate: c("2010-01-01"), status: "TERMINATED",
    });
    expect(undated).toMatchObject({ ok: false, code: "EXIT_DATE_REQUIRED" });
  });

  it("'currently employed' is decided by the last working day, not the status column", () => {
    expect(employedOnWhere(c("2026-08-31"))).toEqual({
      OR: [{ exitDate: null }, { exitDate: { gte: d("2026-08-31") } }],
    });
  });
});

describe("the employment window never moves under recorded attendance (M3)", () => {
  it("refuses an earlier exit that would strand recorded days, naming how many and when", async () => {
    mockDb.attendanceEntry.aggregate.mockResolvedValue({
      _count: { _all: 3 }, _min: { date: d("2026-11-03") }, _max: { date: d("2026-11-20") },
    });
    const res = await updateEmployee({ ...base, patch: { exitDate: c("2026-10-31"), status: "RESIGNED" } });
    expect(res).toMatchObject({ ok: false, code: "ENTRIES_OUTSIDE_WINDOW" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toContain("3 recorded days");
    expect(res.message).toContain("2026-11-03 to 2026-11-20");
    expect(mockDb.employee.updateMany).not.toHaveBeenCalled();

    // The query asks exactly for rows outside the RESULTING window, on this
    // employee, in this org.
    const where = mockDb.attendanceEntry.aggregate.mock.calls[0][0].where;
    expect(where).toMatchObject({ organizationId: ORG, employeeId: "e1" });
    expect(where.OR).toEqual([
      { date: { lt: d("2019-01-15") } },
      { date: { gt: d("2026-10-31") } },
    ]);
  });

  it("a later joining date is checked the same way", async () => {
    mockDb.attendanceEntry.aggregate.mockResolvedValue({
      _count: { _all: 1 }, _min: { date: d("2019-02-01") }, _max: { date: d("2019-02-01") },
    });
    const res = await updateEmployee({ ...base, patch: { joiningDate: c("2019-03-01") } });
    expect(res).toMatchObject({ ok: false, code: "ENTRIES_OUTSIDE_WINDOW" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toContain("1 recorded day (2019-02-01)");
  });

  it("proceeds when nothing is stranded, and never asks when no date changed", async () => {
    const dated = await updateEmployee({ ...base, patch: { exitDate: c("2026-12-31") } });
    expect(dated.ok).toBe(true);
    expect(mockDb.attendanceEntry.aggregate).toHaveBeenCalledTimes(1);

    const rename = await updateEmployee({ ...base, patch: { name: "Renamed" } });
    expect(rename.ok).toBe(true);
    expect(mockDb.attendanceEntry.aggregate).toHaveBeenCalledTimes(1);
  });
});

describe("the write is org-bound in the WHERE (M6)", () => {
  it("updates through a compound where and re-reads the row", async () => {
    mockDb.employee.findFirst
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ name: "Renamed" }));
    const res = await updateEmployee({ ...base, patch: { name: "Renamed" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.employee.name).toBe("Renamed");
    expect(mockDb.employee.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e1", organizationId: ORG } }),
    );
    // The audit is a diff of the read and the re-read: what changed, from
    // what, to what.
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toEqual({ changed: { name: { from: "Someone", to: "Renamed" } } });
  });

  it("a write that matched no row in this org is NOT FOUND, not a silent success", async () => {
    mockDb.employee.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateEmployee({ ...base, patch: { name: "Renamed" } });
    expect(res).toMatchObject({ ok: false, code: "EMPLOYEE_NOT_FOUND" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("the audit row is a field diff that never quotes free text (M7)", () => {
  it("records that notes changed, and not what they say", async () => {
    mockDb.employee.findFirst
      .mockResolvedValueOnce(row({ notes: "old" }))
      .mockResolvedValueOnce(row({ notes: "Was off sick with a named condition." }));
    await updateEmployee({ ...base, patch: { notes: "Was off sick with a named condition." } });
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls[0][0].data.changes);
    expect(JSON.parse(audit)).toEqual({ changed: { notes: "changed" } });
    expect(audit).not.toContain("named condition");
    expect(audit).not.toContain("old");
  });

  it("writes no audit row for a save that changed nothing", async () => {
    await updateEmployee({ ...base, patch: { name: "Someone" } });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("a linked login must belong to this organisation (M5)", () => {
  it("create refuses a login from another org, or none, with one answer", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    const res = await createEmployee({
      organizationId: ORG, actorUserId: "u1", source: "ui", empCode: "X9", name: "Linked",
      joiningDate: c("2026-01-01"), userId: "cmth0oni60005y917w5lybinj",
    });
    expect(res).toMatchObject({ ok: false, code: "USER_NOT_IN_ORG" });
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmth0oni60005y917w5lybinj", organizationId: ORG } }),
    );
    expect(mockDb.employee.create).not.toHaveBeenCalled();
  });

  it("update validates a new link the same way, and null unlinks without a lookup", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    const bad = await updateEmployee({ ...base, patch: { userId: "cmth0oni60005y917w5lybinj" } });
    expect(bad).toMatchObject({ ok: false, code: "USER_NOT_IN_ORG" });
    expect(mockDb.employee.updateMany).not.toHaveBeenCalled();

    mockDb.user.findFirst.mockClear();
    const unlink = await updateEmployee({ ...base, patch: { userId: null } });
    expect(unlink.ok).toBe(true);
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    expect(mockDb.employee.updateMany.mock.calls[0][0].data).toMatchObject({ userId: null });
  });

  it("a login already linked elsewhere is a 409-class answer on update too, not a paging 500", async () => {
    mockDb.employee.updateMany.mockRejectedValue({ code: "P2002", meta: { target: ["userId"] } });
    const res = await updateEmployee({ ...base, patch: { userId: "cmth0oni60005y917w5lybinj" } });
    expect(res).toMatchObject({ ok: false, code: "USER_ALREADY_LINKED" });
    expect(mockApiLogger.error).not.toHaveBeenCalled();
  });
});
