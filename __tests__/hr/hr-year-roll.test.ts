import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The year-end roll (review H6, Aug 31 2026): the piece that turns one leave
 * year's closing balance into the next year's carry-in. Until it existed,
 * `LeaveGrant` had no writer and 1 January reset everyone to the go-live seeds.
 */

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    employee: { findMany: vi.fn(), findFirst: vi.fn() },
    attendanceEntry: { findMany: vi.fn() },
    attendanceRule: { findMany: vi.fn() },
    publicHoliday: { findMany: vi.fn() },
    leaveGrant: { findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  dbOperator: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) => cb(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { rollLeaveYear } from "@/hr/services/leave-year-roll-service";

const ORG = "org1";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function employee(over: Record<string, unknown>) {
  return {
    id: "e", empCode: "EMP", name: "Someone", department: null, jobTitle: null,
    joiningDate: d("2020-01-15"), exitDate: null, status: "ACTIVE",
    carryoverDays: 0, openingSickUsed: 0, openingCompOff: 0,
    annualEntitlementDays: null, seedLeaveYear: 2026, userId: null, notes: null,
    ...over,
  };
}

/** N annual-leave rows for one employee, weekdays from 2 March 2026 onwards. */
function annualRows(employeeId: string, count: number) {
  const out: { employeeId: string; date: Date; leaveCode: { countsAs: string; dayWeight: number } }[] = [];
  let t = d("2026-03-02").getTime();
  while (out.length < count) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      out.push({ employeeId, date: day, leaveCode: { countsAs: "ANNUAL", dayWeight: 1 } });
    }
    t += 86_400_000;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.attendanceRule.findMany.mockResolvedValue([]);
  mockDb.publicHoliday.findMany.mockResolvedValue([]);
  mockDb.leaveGrant.findMany.mockResolvedValue([]);
  mockDb.leaveGrant.upsert.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("rollLeaveYear", () => {
  it("writes next year's grant from this year's closing balance, capped one way", async () => {
    mockDb.employee.findMany.mockResolvedValue([
      // Overdrawn: 30 + 4 carried - 45 taken = -11, carried in FULL.
      employee({ id: "a", empCode: "A", carryoverDays: 4 }),
      // Untouched: 30 + 30 carried = 60, capped to 30.
      employee({ id: "b", empCode: "B", carryoverDays: 30 }),
    ]);
    mockDb.attendanceEntry.findMany.mockResolvedValue(annualRows("a", 45));

    const res = await rollLeaveYear({ organizationId: ORG, fromYear: 2026, actorUserId: "u1", source: "ui" });

    expect(res).toMatchObject({ fromYear: 2026, toYear: 2027, granted: 2, skipped: 0 });
    expect(res.capped).toEqual([{ employeeId: "b", empCode: "B", closing: 60, carried: 30 }]);

    const byEmployee = new Map(
      mockDb.leaveGrant.upsert.mock.calls.map((c) => [c[0].where.organizationId_employeeId_leaveYear.employeeId, c[0]]),
    );
    expect(byEmployee.get("a")).toMatchObject({
      where: { organizationId_employeeId_leaveYear: { organizationId: ORG, employeeId: "a", leaveYear: 2027 } },
      create: { organizationId: ORG, employeeId: "a", leaveYear: 2027, entitlementDays: 30, carriedInDays: -11 },
      update: { carriedInDays: -11 },
    });
    expect(byEmployee.get("b")?.create).toMatchObject({ carriedInDays: 30 });

    // One audit row per run, counts plus the capped set, never a per-person dump.
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toMatchObject({ source: "ui", fromYear: 2026, toYear: 2027, granted: 2 });
    expect(changes.capped).toEqual([{ empCode: "B", closing: 60, carried: 30 }]);
  });

  it("writes no grant for somebody who left before the new year, or was not employed in the old one", async () => {
    mockDb.employee.findMany.mockResolvedValue([
      employee({ id: "gone", empCode: "GONE", exitDate: d("2026-06-30"), status: "RESIGNED" }),
      employee({ id: "future", empCode: "FUT", joiningDate: d("2027-02-01") }),
      employee({ id: "stays", empCode: "STAY" }),
    ]);
    mockDb.attendanceEntry.findMany.mockResolvedValue([]);

    const res = await rollLeaveYear({ organizationId: ORG, fromYear: 2026, actorUserId: null, source: "cron" });

    expect(res).toMatchObject({ granted: 1, skipped: 2 });
    expect(mockDb.leaveGrant.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.leaveGrant.upsert.mock.calls[0][0].create.employeeId).toBe("stays");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.userId).toBeNull();
  });

  it("never rolls INTO an employee's seed year: the typed carry-in is the record there", async () => {
    // Everyone imported from the 2026 workbook is seeded 2026. Rolling 2025 into
    // 2026 would compute "30 minus nothing" and overwrite every imported
    // carry-over with +30, because a grant beats the seed.
    mockDb.employee.findMany.mockResolvedValue([
      employee({ id: "seeded", empCode: "S26", carryoverDays: 4, seedLeaveYear: 2026 }),
      employee({ id: "older", empCode: "S25", carryoverDays: 0, seedLeaveYear: 2025 }),
    ]);
    mockDb.attendanceEntry.findMany.mockResolvedValue([]);

    const res = await rollLeaveYear({ organizationId: ORG, fromYear: 2025, actorUserId: "u1", source: "ui" });

    expect(res).toMatchObject({ granted: 1, skipped: 1 });
    expect(mockDb.leaveGrant.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.leaveGrant.upsert.mock.calls[0][0].create.employeeId).toBe("older");
  });

  it("records a zero entitlement on the grant for somebody still inside their first year", async () => {
    mockDb.employee.findMany.mockResolvedValue([
      employee({ id: "new", empCode: "NEW", joiningDate: d("2026-09-01") }),
    ]);
    mockDb.attendanceEntry.findMany.mockResolvedValue([]);
    await rollLeaveYear({ organizationId: ORG, fromYear: 2026, actorUserId: "u1", source: "ui" });
    expect(mockDb.leaveGrant.upsert.mock.calls[0][0].create).toMatchObject({ entitlementDays: 0, carriedInDays: 0 });
  });
});

describe("the worker tick", () => {
  it("acts only in January, and only where the module is on", async () => {
    vi.resetModules();
    vi.doMock("@/lib/module-flags", () => ({ isHrModuleEnabled: () => true }));
    vi.doMock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
    const roll = vi.fn().mockResolvedValue({ fromYear: 2026, toYear: 2027, granted: 1, skipped: 0, capped: [] });
    vi.doMock("@/hr/services/leave-year-roll-service", () => ({ rollLeaveYear: roll }));
    mockDb.employee.findMany.mockResolvedValue([{ organizationId: "org1" }, { organizationId: "org2" }]);

    const { runHrYearRollTick, isRollWindow } = await import("@/hr/hr-year-roll-worker");
    expect(isRollWindow("2027-01-01")).toBe(true);
    expect(isRollWindow("2027-01-31")).toBe(true);
    expect(isRollWindow("2027-02-01")).toBe(false);

    const feb = await runHrYearRollTick("2027-02-01");
    expect(feb).toEqual({ ran: false, reason: "not-january", results: [] });
    expect(roll).not.toHaveBeenCalled();

    const jan = await runHrYearRollTick("2027-01-05");
    expect(jan.ran).toBe(true);
    expect(jan.results).toHaveLength(2);
    expect(roll).toHaveBeenCalledTimes(2);
    expect(roll.mock.calls[0][0]).toMatchObject({ organizationId: "org1", fromYear: 2026, source: "cron", actorUserId: null });
  });

  it("is a no-op where the HR module is switched off", async () => {
    vi.resetModules();
    vi.doMock("@/lib/module-flags", () => ({ isHrModuleEnabled: () => false }));
    const roll = vi.fn();
    vi.doMock("@/hr/services/leave-year-roll-service", () => ({ rollLeaveYear: roll }));
    const { runHrYearRollTick } = await import("@/hr/hr-year-roll-worker");
    expect(await runHrYearRollTick("2027-01-05")).toEqual({ ran: false, reason: "module-off", results: [] });
    expect(roll).not.toHaveBeenCalled();
  });
});

describe("worker roster", () => {
  it("is registered, so the digest's under-run check can see it, with a unique lease id", async () => {
    const { EXPECTED_JOB_NAMES } = await import("@/lib/worker-jobs");
    const { JOB_NAME, JOB_ID, SCHEDULE } = await import("../../worker/jobs/hr-year-roll");
    const { JOB_IDS } = await import("../../worker/lib/job-ids");
    expect(EXPECTED_JOB_NAMES.has(JOB_NAME)).toBe(true);
    expect(SCHEDULE).toBe("5 1 * * *");
    const ids = Object.values(JOB_IDS);
    expect(ids.filter((id) => id === JOB_ID)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
