/**
 * The dtcm-issue worker's share of each tick across runs (review of DTCM
 * steps 0 to 5, MED 5): one long run must not take the whole tick from every
 * other event's run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOperator, tick } = vi.hoisted(() => ({
  mockOperator: { dtcmIssueRun: { findMany: vi.fn() } },
  tick: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ dbOperator: mockOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: string, _m: unknown, fn: () => unknown) => fn() }));
vi.mock("@/services/dtcm-issue-run-service", () => ({ tickDtcmRun: tick }));

import { tickAllDtcmRuns } from "@/lib/dtcm-eticket/issue-worker";

beforeEach(() => {
  vi.clearAllMocks();
  tick.mockResolvedValue(undefined);
});

describe("tickAllDtcmRuns", () => {
  it("gives every run a share of the tick, not the first run all of it", async () => {
    mockOperator.dtcmIssueRun.findMany.mockResolvedValue([
      { id: "a", organizationId: "o1" },
      { id: "b", organizationId: "o2" },
      { id: "c", organizationId: "o1" },
    ]);
    await tickAllDtcmRuns();
    expect(tick.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    // The first run gets a third of the 45 s budget, not all of it.
    const firstBudget = tick.mock.calls[0][1];
    expect(firstBudget).toBeGreaterThan(14_000);
    expect(firstBudget).toBeLessThanOrEqual(15_000);
  });

  it("works the run that waited longest first", async () => {
    mockOperator.dtcmIssueRun.findMany.mockResolvedValue([]);
    await tickAllDtcmRuns();
    expect(mockOperator.dtcmIssueRun.findMany.mock.calls[0][0].orderBy).toEqual([
      { lastTickAt: { sort: "asc", nulls: "first" } },
      { startedAt: "asc" },
    ]);
  });

  it("a run that finishes early leaves its share to the runs after it", async () => {
    mockOperator.dtcmIssueRun.findMany.mockResolvedValue([
      { id: "a", organizationId: "o1" },
      { id: "b", organizationId: "o1" },
    ]);
    await tickAllDtcmRuns();
    // "a" returned at once, so "b" gets nearly the whole budget.
    expect(tick.mock.calls[1][1]).toBeGreaterThan(44_000);
  });
});
