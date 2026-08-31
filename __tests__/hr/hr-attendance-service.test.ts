import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { HR_LEAVE_CODE_SEED } from "@/hr/lib/hr-seed-data";

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
    attendanceEntry: { deleteMany: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const mockApiLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockDb, mockTx, mockApiLogger };
});

const mockTenantTx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown, opts?: unknown) => mockTenantTx(cb, opts),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
// The tier check asks the ONE balance engine; mocked here so these tests are
// about the projection arithmetic and not about re-testing the engine.
const mockGetBalance = vi.hoisted(() => vi.fn());
vi.mock("@/hr/services/leave-balance-service", () => ({ getLeaveBalance: mockGetBalance }));

import { clearAttendance, setAttendance } from "@/hr/services/attendance-service";

const ORG = "org1";
const EMP = "emp1";
const base = { organizationId: ORG, actorUserId: "u1", employeeId: EMP };

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantTx.mockImplementation((cb: (tx: unknown) => unknown) => cb(mockTx));
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
  mockDb.attendanceEntry.findMany.mockResolvedValue([]);
  mockGetBalance.mockResolvedValue(null);
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

/**
 * Review M12 (Aug 31 2026). A full-year range is up to 366 statements in one
 * interactive transaction, and Prisma's default budget is 5 s, so the largest
 * legitimate range was the one most likely to fail, as an opaque UNKNOWN.
 */
describe("the transaction budget and the timeout answer (M12)", () => {
  it("runs a range write under a budget sized for a year, not Prisma's 5 s default", async () => {
    mockDb.employee.findFirst.mockResolvedValue({ id: EMP, joiningDate: new Date("2020-01-01T00:00:00Z"), exitDate: null });
    mockDb.leaveCode.findFirst.mockResolvedValue({ id: "lc", code: "WFH", countsAs: "WORK" });
    mockDb.publicHoliday.findMany.mockResolvedValue([]);
    mockTx.attendanceEntry.findMany.mockResolvedValue([]);
    mockTx.attendanceEntry.upsert.mockResolvedValue({});
    await setAttendance({ ...base, from: "2026-01-05" as never, to: "2026-01-09" as never, code: "WFH", source: "ui" });
    const opts = mockTenantTx.mock.calls[0][1] as { timeout?: number; maxWait?: number };
    expect(opts.timeout).toBeGreaterThanOrEqual(30_000);
    expect(opts.maxWait).toBeGreaterThanOrEqual(5_000);
  });

  it("a timed-out transaction is WRITE_TIMED_OUT, naming the size, not UNKNOWN", async () => {
    mockDb.employee.findFirst.mockResolvedValue({ id: EMP, joiningDate: new Date("2020-01-01T00:00:00Z"), exitDate: null });
    mockDb.leaveCode.findFirst.mockResolvedValue({ id: "lc", code: "WFH", countsAs: "WORK" });
    mockDb.publicHoliday.findMany.mockResolvedValue([]);
    mockTenantTx.mockRejectedValue({ code: "P2028" });
    const res = await setAttendance({ ...base, from: "2026-01-05" as never, to: "2026-01-09" as never, code: "WFH", source: "ui" });
    expect(res).toMatchObject({ ok: false, code: "WRITE_TIMED_OUT" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toContain("5 days");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

/**
 * The 15-day full-pay sick limit, as a WARNING and not a conversion.
 *
 * Owner ruling, Aug 31 2026. The tier is decided by which CODE is recorded, so
 * moving somebody into half pay automatically would make the grid show SL-F
 * while payroll pays half: the record would stop being the truth. So the write
 * is refused once, with the numbers, and HR chooses.
 */
describe("full-pay sick tier", () => {
  it("names the code and carries the numbers, so the UI can ask rather than guess", () => {
    const src = readFileSync(
      join(process.cwd(), "src/hr/services/attendance-service.ts"),
      "utf8",
    );
    expect(src).toContain('"SICK_FULL_TIER_EXCEEDED"');
    // The numbers the dialog puts on screen. A bare message would force the UI
    // to parse prose to say "10 of 15, this makes it 16".
    for (const key of ["leaveYear", "used", "adding", "wouldBe", "limit"]) {
      expect(src, `meta.${key} is what the dialog reads`).toContain(key);
    }
  });

  /**
   * The load-bearing one. If the check ran on the day COUNT rather than the
   * day WEIGHT, ten SL-HD half days would read as ten full days and warn at the
   * wrong time; and if it did not subtract what it is overwriting, re-saving an
   * existing sick day would look like adding one.
   */
  it("counts weight, not days, and subtracts what it replaces", () => {
    const src = readFileSync(
      join(process.cwd(), "src/hr/services/attendance-service.ts"),
      "utf8",
    );
    expect(src).toContain("newDayWeight");
    expect(src).toContain("replacingByYear");
    // And it asks the ONE balance engine rather than counting a second time.
    expect(src).toContain("getLeaveBalance(");
  });

  /** The override exists, or the ruling would be "the system decides" after all. */
  it("can be acknowledged and proceeded past", () => {
    const src = readFileSync(
      join(process.cwd(), "src/hr/services/attendance-service.ts"),
      "utf8",
    );
    expect(src).toContain("acknowledgeSickTier");
    expect(src).toContain("!input.acknowledgeSickTier");
  });
});

/**
 * Working a public holiday earns NOTHING back; only both days of one weekend
 * do (owner, Aug 27 2026, reaffirmed Aug 31). The label used to promise
 * otherwise, which matters now that the picker shows labels rather than codes.
 */
describe("the On-Duty label matches the comp-off rule", () => {
  it("does not promise a day back for holiday work", () => {
    const od = HR_LEAVE_CODE_SEED.find((c) => c.code === "OD");
    expect(od?.label).toBe("On Duty (weekend work)");
    expect(od?.label.toLowerCase()).not.toContain("holiday");
  });
});

describe("the sick tier check, driven through setAttendance", () => {
  const sick = (dayWeight: number, code = "SL-F") => ({
    id: "lc-sl", code, countsAs: "SICK_FULL", dayWeight,
  });
  const balanceWith = (used: number) => ({
    balance: { employedInYear: true, sick: { full: { used, limit: 15, remaining: 15 - used } } },
  });

  it("refuses the write that crosses 15, and says by how much", async () => {
    mockDb.leaveCode.findFirst.mockResolvedValue(sick(1));
    mockGetBalance.mockResolvedValue(balanceWith(10));
    // Six more full days on top of ten is sixteen.
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", to: "2026-06-08", code: "SL-F",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SICK_FULL_TIER_EXCEEDED");
    expect(res.meta?.used).toBe(10);
    expect(Number(res.meta?.wouldBe)).toBeGreaterThan(15);
    expect(mockTx.attendanceEntry.upsert).not.toHaveBeenCalled();
  });

  it("lets the write that lands exactly on 15 through", async () => {
    mockDb.leaveCode.findFirst.mockResolvedValue(sick(1));
    mockGetBalance.mockResolvedValue(balanceWith(10));
    // Mon-Fri is five working days: 10 + 5 = 15, which is the entitlement, not past it.
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", to: "2026-06-05", code: "SL-F",
    });
    expect(res.ok).toBe(true);
    expect(mockTx.attendanceEntry.upsert).toHaveBeenCalled();
  });

  /**
   * THE ONE THAT WOULD BE SILENTLY WRONG. SL-HD is half a day and also counts
   * against this tier. Counting DAYS rather than WEIGHT would call six half
   * days six, warn at 16, and stop a perfectly legal write.
   */
  it("counts a half day as half a day", async () => {
    mockDb.leaveCode.findFirst.mockResolvedValue(sick(0.5, "SL-HD"));
    mockGetBalance.mockResolvedValue(balanceWith(10));
    // Six half days is three: 13, not 16.
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", to: "2026-06-08", code: "SL-HD",
    });
    expect(res.ok).toBe(true);
  });

  /** Re-saving a day that is ALREADY sick is not a new sick day. */
  it("subtracts what it is overwriting", async () => {
    mockDb.leaveCode.findFirst.mockResolvedValue(sick(1));
    mockGetBalance.mockResolvedValue(balanceWith(15));
    mockDb.attendanceEntry.findMany.mockResolvedValue([
      { date: new Date("2026-06-01T00:00:00Z"), leaveCode: { countsAs: "SICK_FULL", dayWeight: 1 } },
    ]);
    // 15 used, one of which is the day being rewritten: 15 - 1 + 1 = 15.
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", code: "SL-F",
    });
    expect(res.ok).toBe(true);
  });

  it("proceeds when HR acknowledges it", async () => {
    mockDb.leaveCode.findFirst.mockResolvedValue(sick(1));
    mockGetBalance.mockResolvedValue(balanceWith(10));
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", to: "2026-06-08", code: "SL-F",
      acknowledgeSickTier: true,
    });
    expect(res.ok).toBe(true);
  });

  it("never asks about a code that is not full-pay sick", async () => {
    mockGetBalance.mockResolvedValue(balanceWith(99));
    const res = await setAttendance({
      ...base, source: "ui", from: "2026-06-01", to: "2026-06-08", code: "AL",
    });
    expect(res.ok).toBe(true);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});
