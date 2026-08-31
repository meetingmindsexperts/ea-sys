import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The DB-backed entry points to the balance engine, with the database mocked.
 *
 * Two things live here and nowhere else. Review M14: the source-grep guards
 * that "the balance service adopts the resolver" passed a mutation that
 * replaced the explicit-dates set with an empty one, which double-charges every
 * recorded day inside a rule window; only running the service catches that.
 * Review M4: a year the system holds nothing for is refused, and a past year
 * is "as at" its own end.
 */

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    employee: { findFirst: vi.fn(), findMany: vi.fn() },
    attendanceEntry: { findMany: vi.fn() },
    attendanceRule: { findMany: vi.fn() },
    publicHoliday: { findMany: vi.fn() },
    leaveGrant: { findMany: vi.fn() },
  },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  LeaveYearNotHeldError,
  getLeaveBalance,
  getOrgLeaveSummary,
} from "@/hr/services/leave-balance-service";

const ORG = "org1";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const employee = {
  id: "e1", empCode: "EMP001", name: "Someone", department: null, jobTitle: null,
  joiningDate: d("2020-01-15"), exitDate: null, status: "ACTIVE",
  carryoverDays: 0, openingSickUsed: 0, openingCompOff: 0,
  annualEntitlementDays: null, seedLeaveYear: 2026, userId: null, notes: null,
};
/** The office is shut 2 to 6 March 2026: five working days of annual leave. */
const shutdown = {
  id: "r-shut", scope: "ORG", employeeId: null,
  startDate: d("2026-03-02"), endDate: d("2026-03-06"),
  leaveCode: { code: "AL", countsAs: "ANNUAL", dayWeight: 1 },
};
/** And somebody had already recorded the Wednesday of that week as AL. */
const wednesday = {
  employeeId: "e1", date: d("2026-03-04"),
  leaveCode: { countsAs: "ANNUAL", dayWeight: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.employee.findFirst.mockResolvedValue(employee);
  mockDb.employee.findMany.mockResolvedValue([employee]);
  mockDb.attendanceEntry.findMany.mockResolvedValue([wednesday]);
  mockDb.attendanceRule.findMany.mockResolvedValue([shutdown]);
  mockDb.publicHoliday.findMany.mockResolvedValue([]);
  mockDb.leaveGrant.findMany.mockResolvedValue([]);
});

describe("a recorded day inside a rule window is charged once (M14)", () => {
  it("on the per-employee path", async () => {
    const res = await getLeaveBalance({ organizationId: ORG, employeeId: "e1", asOf: "2026-08-31" as never });
    expect(res?.balance.annual.taken).toBe(5);
  });

  it("on the org summary path", async () => {
    const rows = await getOrgLeaveSummary({ organizationId: ORG, asOf: "2026-08-31" as never });
    expect(rows).toHaveLength(1);
    expect(rows[0].balance.annual.taken).toBe(5);
  });
});

describe("a year the system holds nothing for is refused (M4)", () => {
  it("per employee: before the seed year with no grant", async () => {
    await expect(
      getLeaveBalance({ organizationId: ORG, employeeId: "e1", leaveYear: 2025, asOf: "2026-08-31" as never }),
    ).rejects.toBeInstanceOf(LeaveYearNotHeldError);
  });

  it("per employee: a grant for that year makes it answerable, as at its own end", async () => {
    mockDb.leaveGrant.findMany.mockResolvedValue([{ employeeId: "e1", carriedInDays: 3 }]);
    mockDb.attendanceEntry.findMany.mockResolvedValue([]);
    const res = await getLeaveBalance({ organizationId: ORG, employeeId: "e1", leaveYear: 2025, asOf: "2026-08-31" as never });
    expect(res?.balance.leaveYear).toBe(2025);
    // "As at" 31 December 2025, not today: the gate, the anniversary and the
    // comp-off bound all read asOf.
    expect(res?.balance.asOf).toBe("2025-12-31");
    expect(res?.balance.annual.carriedIn).toBe(3);
  });

  it("the org summary: before everyone's seed year with no grants anywhere", async () => {
    await expect(
      getOrgLeaveSummary({ organizationId: ORG, leaveYear: 2025, asOf: "2026-08-31" as never }),
    ).rejects.toMatchObject({ code: "YEAR_NOT_HELD", year: 2025 });
  });

  it("the current year is never refused", async () => {
    const rows = await getOrgLeaveSummary({ organizationId: ORG, asOf: "2026-08-31" as never });
    expect(rows[0].balance.asOf).toBe("2026-08-31");
  });
});
