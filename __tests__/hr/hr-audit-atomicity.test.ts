import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Dependency audit HR-1 (Nov 3 2026): every HR change and its audit row commit
 * together. The audit row used to be written AFTER the change, with its failure
 * caught and logged, so a change could commit with no record of who made it
 * (for attendance, no record of what it overwrote, which is the only undo).
 *
 * `tx` and `db` are separate mocks here, so these pin two things at once: the
 * audit goes through the transaction, never the plain client, and a rejected
 * audit write fails the whole call instead of being swallowed. With Prisma that
 * rejection rolls the change back.
 */

const { mockDb, mockTx, mockApiLogger } = vi.hoisted(() => {
  const mockTx = {
    employee: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    attendanceEntry: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    attendanceRule: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const mockDb = {
    employee: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    leaveCode: { findFirst: vi.fn() },
    publicHoliday: { findMany: vi.fn() },
    attendanceEntry: { findMany: vi.fn(), aggregate: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const mockApiLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockDb, mockTx, mockApiLogger };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) => cb(mockTx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/hr/services/leave-balance-service", () => ({
  getLeaveBalance: vi.fn(),
  LeaveYearNotHeldError: class extends Error {},
}));

import { createEmployee, updateEmployee } from "@/hr/services/employee-service";
import { clearAttendance, setAttendance } from "@/hr/services/attendance-service";
import { createAttendanceRule, deleteAttendanceRule } from "@/hr/services/attendance-rule-service";

const ORG = "org1";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
function employeeRow(over: Record<string, unknown> = {}) {
  return {
    id: "e1", empCode: "EMP001", name: "Someone", department: null, jobTitle: null,
    joiningDate: d("2019-01-15"), exitDate: null, status: "ACTIVE",
    carryoverDays: 0, openingSickUsed: 0, openingCompOff: 0,
    annualEntitlementDays: null, seedLeaveYear: 2026, userId: null, notes: null,
    ...over,
  };
}
const ruleRow = {
  id: "r1", scope: "EMPLOYEE", employeeId: "e1", startDate: d("2026-11-02"), endDate: null,
  label: "Works remotely", source: "ui", createdAt: d("2026-11-03"),
  leaveCode: { code: "WFH", label: "Work From Home", countsAs: "WORK" },
  employee: { name: "Someone" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.employee.findFirst.mockResolvedValue(employeeRow());
  mockDb.leaveCode.findFirst.mockResolvedValue({ id: "lc", code: "WFH", countsAs: "WORK", dayWeight: 1 });
  mockDb.publicHoliday.findMany.mockResolvedValue([]);
  mockDb.attendanceEntry.findMany.mockResolvedValue([]);
  mockDb.attendanceEntry.aggregate.mockResolvedValue({
    _count: { _all: 0 }, _min: { date: null }, _max: { date: null },
  });
  mockTx.employee.create.mockImplementation(async ({ data }) => employeeRow(data));
  mockTx.employee.updateMany.mockResolvedValue({ count: 1 });
  mockTx.employee.findFirst.mockResolvedValue(employeeRow({ name: "Renamed" }));
  mockTx.attendanceEntry.findMany.mockResolvedValue([]);
  mockTx.attendanceEntry.upsert.mockResolvedValue({});
  mockTx.attendanceEntry.deleteMany.mockResolvedValue({ count: 0 });
  mockTx.attendanceRule.create.mockResolvedValue(ruleRow);
  mockTx.attendanceRule.findFirst.mockResolvedValue(ruleRow);
  mockTx.attendanceRule.deleteMany.mockResolvedValue({ count: 1 });
  mockTx.auditLog.create.mockResolvedValue({});
  // The plain client's audit SUCCEEDS, so the old shape (audit on `db` after
  // the commit) would report success and fail these tests for the right reason.
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.employee.create.mockImplementation(async ({ data }) => employeeRow(data));
  mockDb.employee.updateMany.mockResolvedValue({ count: 1 });
});

/** Every HR write, as a call that should succeed when the audit does. */
const writes: [string, () => Promise<{ ok: boolean }>][] = [
  ["createEmployee", () => createEmployee({
    organizationId: ORG, actorUserId: "u1", source: "ui",
    empCode: "EMP099", name: "New Person", joiningDate: "2026-01-05",
  } as Parameters<typeof createEmployee>[0])],
  ["updateEmployee", () => updateEmployee({
    organizationId: ORG, actorUserId: "u1", employeeId: "e1", patch: { name: "Renamed" },
  })],
  ["setAttendance", () => setAttendance({
    organizationId: ORG, actorUserId: "u1", employeeId: "e1", source: "ui",
    from: "2026-11-04", code: "WFH",
  })],
  ["clearAttendance", () => clearAttendance({
    organizationId: ORG, actorUserId: "u1", employeeId: "e1", from: "2026-11-04",
  })],
  ["createAttendanceRule", () => createAttendanceRule({
    organizationId: ORG, actorUserId: "u1", source: "ui", scope: "EMPLOYEE",
    employeeId: "e1", code: "WFH", startDate: "2026-11-02", endDate: null, label: "Works remotely",
  })],
  ["deleteAttendanceRule", () => deleteAttendanceRule({
    organizationId: ORG, actorUserId: "u1", ruleId: "r1", source: "ui",
  })],
];

describe.each(writes)("%s", (_name, write) => {
  it("writes its audit row inside the transaction, stamped with the organisation", async () => {
    const res = await write();
    expect(res.ok).toBe(true);
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockTx.auditLog.create.mock.calls[0][0].data.organizationId).toBe(ORG);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("fails when the audit write fails, instead of reporting success", async () => {
    mockTx.auditLog.create.mockRejectedValue(new Error("audit insert failed"));
    const res = await write().catch(() => ({ ok: false }));
    expect(res.ok).toBe(false);
  });
});

describe("deleteAttendanceRule", () => {
  it("writes no audit row when nothing was deleted", async () => {
    mockTx.attendanceRule.deleteMany.mockResolvedValue({ count: 0 });
    const res = await deleteAttendanceRule({
      organizationId: ORG, actorUserId: "u1", ruleId: "gone", source: "ui",
    });
    expect(res).toMatchObject({ ok: false, code: "RULE_NOT_FOUND" });
    expect(mockTx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("updateEmployee", () => {
  it("writes no audit row when nothing actually changed", async () => {
    mockTx.employee.findFirst.mockResolvedValue(employeeRow());
    const res = await updateEmployee({
      organizationId: ORG, actorUserId: "u1", employeeId: "e1", patch: { name: "Someone" },
    });
    expect(res.ok).toBe(true);
    expect(mockTx.auditLog.create).not.toHaveBeenCalled();
  });
});
