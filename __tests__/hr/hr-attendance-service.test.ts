import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Review H5 (Aug 31 2026). Attendance history was unrecoverable: a clear was an
 * unbounded hard delete audited by count, an overwrite recorded only the new
 * code, and re-coding a day wiped its remark. These pin the reversal data on
 * the audit row, the range cap on the delete, and the remarks contract.
 */

const { mockDb, mockTx, mockApiLogger } = vi.hoisted(() => {
  const mockTx = {
    attendanceEntry: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const mockDb = {
    employee: { findFirst: vi.fn() },
    leaveCode: { findFirst: vi.fn() },
    publicHoliday: { findMany: vi.fn() },
    attendanceEntry: { deleteMany: vi.fn() },
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

import { clearAttendance, setAttendance } from "@/hr/services/attendance-service";

const ORG = "org1";
const EMP = "emp1";
const base = { organizationId: ORG, actorUserId: "u1", employeeId: EMP };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.employee.findFirst.mockResolvedValue({
    id: EMP,
    joiningDate: new Date("2020-01-01T00:00:00Z"),
    exitDate: null,
  });
  mockDb.leaveCode.findFirst.mockResolvedValue({ id: "lc-al", code: "AL", countsAs: "ANNUAL" });
  mockDb.publicHoliday.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockTx.attendanceEntry.findMany.mockResolvedValue([]);
  mockTx.attendanceEntry.upsert.mockResolvedValue({});
  mockTx.attendanceEntry.deleteMany.mockResolvedValue({ count: 0 });
});

function auditChanges(): Record<string, unknown> {
  const call = mockDb.auditLog.create.mock.calls[0]?.[0] as { data: { changes: Record<string, unknown> } };
  return call.data.changes;
}

describe("clearAttendance", () => {
  it("refuses a range longer than a year, and deletes nothing", async () => {
    const res = await clearAttendance({ ...base, from: "2000-01-01", to: "2100-12-31" });
    expect(res).toMatchObject({ ok: false, code: "RANGE_TOO_LONG" });
    expect(mockTx.attendanceEntry.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("still allows a whole year", async () => {
    const res = await clearAttendance({ ...base, from: "2026-01-01", to: "2026-12-31" });
    expect(res.ok).toBe(true);
  });

  it("snapshots every deleted day's code onto the audit row, in the same transaction", async () => {
    mockTx.attendanceEntry.findMany.mockResolvedValue([
      { date: new Date("2026-03-02T00:00:00Z"), leaveCode: { code: "SL-F" } },
      { date: new Date("2026-03-03T00:00:00Z"), leaveCode: { code: "AL" } },
    ]);
    const res = await clearAttendance({ ...base, from: "2026-03-02", to: "2026-03-06" });
    expect(res).toEqual({ ok: true, result: { removed: 2 } });

    // The read and the delete address the same rows.
    const readWhere = mockTx.attendanceEntry.findMany.mock.calls[0][0].where;
    const deleteWhere = mockTx.attendanceEntry.deleteMany.mock.calls[0][0].where;
    expect(deleteWhere).toEqual(readWhere);
    expect(readWhere).toMatchObject({ organizationId: ORG, employeeId: EMP });

    expect(auditChanges()).toMatchObject({
      removed: 2,
      entries: [
        { date: "2026-03-02", code: "SL-F" },
        { date: "2026-03-03", code: "AL" },
      ],
    });
  });
});

describe("setAttendance", () => {
  it("records the code each overwritten day held before", async () => {
    mockTx.attendanceEntry.findMany.mockResolvedValue([
      { date: new Date("2026-03-03T00:00:00Z"), leaveCode: { code: "SL-F" } },
    ]);
    const res = await setAttendance({ ...base, source: "ui", from: "2026-03-02", to: "2026-03-04", code: "AL" });
    expect(res).toMatchObject({ ok: true, result: { written: 3 } });
    expect(auditChanges()).toMatchObject({
      code: "AL",
      days: 3,
      overwritten: [{ date: "2026-03-03", previousCode: "SL-F" }],
    });
    // The snapshot is scoped to exactly the days being written.
    const readWhere = mockTx.attendanceEntry.findMany.mock.calls[0][0].where;
    expect(readWhere.date.in.map((d: Date) => d.toISOString().slice(0, 10))).toEqual([
      "2026-03-02", "2026-03-03", "2026-03-04",
    ]);
  });

  it("leaves an existing remark alone when the caller said nothing about remarks", async () => {
    await setAttendance({ ...base, source: "ui", from: "2026-03-02", code: "AL" });
    const update = mockTx.attendanceEntry.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty("remarks");
    expect(update).toMatchObject({ leaveCodeId: "lc-al" });
  });

  it("writes a supplied remark, and clears on an explicit null", async () => {
    await setAttendance({ ...base, source: "ui", from: "2026-03-02", code: "AL", remarks: "  cert on file " });
    expect(mockTx.attendanceEntry.upsert.mock.calls[0][0].update.remarks).toBe("cert on file");

    vi.clearAllMocks();
    mockDb.employee.findFirst.mockResolvedValue({ id: EMP, joiningDate: new Date("2020-01-01T00:00:00Z"), exitDate: null });
    mockDb.leaveCode.findFirst.mockResolvedValue({ id: "lc-al", code: "AL", countsAs: "ANNUAL" });
    mockTx.attendanceEntry.findMany.mockResolvedValue([]);
    mockTx.attendanceEntry.upsert.mockResolvedValue({});
    mockDb.auditLog.create.mockResolvedValue({});
    await setAttendance({ ...base, source: "ui", from: "2026-03-02", code: "AL", remarks: null });
    expect(mockTx.attendanceEntry.upsert.mock.calls[0][0].update.remarks).toBeNull();
  });

  it("never puts remarks on the audit row", async () => {
    await setAttendance({ ...base, source: "ui", from: "2026-03-02", code: "AL", remarks: "diagnosis" });
    expect(JSON.stringify(auditChanges())).not.toContain("diagnosis");
  });
});
