/**
 * Retention sweep for measured hits.
 *
 * AnalyticsEvent is the highest-write table in the system, so this is not
 * housekeeping: it is what keeps the table a fixed size rather than a slowly
 * worsening query. The properties worth pinning are the cutoff (a wrong one
 * either deletes live data or never deletes anything) and the refusal to report
 * a clean sweep when the backlog outran the tick.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger, mockFindMany, mockDeleteMany } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/db", () => ({
  db: { analyticsEvent: { findMany: mockFindMany, deleteMany: mockDeleteMany } },
  dbOperator: {},
}));

import { runAnalyticsPruneTick, ANALYTICS_RETENTION_DAYS } from "@/lib/analytics-prune-worker";

const NOW = new Date("2026-08-20T03:15:00Z");

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `hit-${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteMany.mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
});

describe("retention window", () => {
  it("keeps 400 days, which is a year-over-year comparison plus margin", () => {
    // Longer than the 180-day sweeps on purpose: the most valuable comparison
    // is this September against last September, which 365 cannot express
    // because the older side has just expired. Affordable only because these
    // rows are not personal data.
    expect(ANALYTICS_RETENTION_DAYS).toBe(400);
  });

  it("deletes strictly older than the cutoff", async () => {
    mockFindMany.mockResolvedValue([]);
    await runAnalyticsPruneTick(NOW);

    const where = mockFindMany.mock.calls[0][0].where;
    const cutoff = where.createdAt.lt as Date;
    const expected = new Date(NOW.getTime() - 400 * 24 * 3600_000);
    expect(cutoff.toISOString()).toBe(expected.toISOString());
    // `lt`, not `lte`: a row exactly on the boundary is kept.
    expect(where.createdAt.lte).toBeUndefined();
  });
});

describe("sweeping", () => {
  it("does nothing, and logs nothing, when there is nothing to delete", async () => {
    mockFindMany.mockResolvedValue([]);
    const res = await runAnalyticsPruneTick(NOW);
    expect(res).toEqual({ deleted: 0, capped: false });
    expect(mockDeleteMany).not.toHaveBeenCalled();
    // A quiet no-op must stay quiet, or the daily digest fills with noise.
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("stops as soon as a batch comes back short", async () => {
    mockFindMany.mockResolvedValueOnce(rows(1000)).mockResolvedValueOnce(rows(7));
    const res = await runAnalyticsPruneTick(NOW);
    expect(res.deleted).toBe(1007);
    expect(res.capped).toBe(false);
    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });

  it("selects then deletes by id, rather than one unbounded deleteMany", async () => {
    // Keeps each statement's lock footprint small on a shared production
    // database that is also serving registrations.
    mockFindMany.mockResolvedValueOnce(rows(3)).mockResolvedValue([]);
    await runAnalyticsPruneTick(NOW);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["hit-0", "hit-1", "hit-2"] } },
    });
  });

  it("reports capped rather than claiming a clean sweep", async () => {
    // A silent cap reads as "nothing left to delete", which is the opposite of
    // the truth and hides a table that is growing faster than it is pruned.
    mockFindMany.mockResolvedValue(rows(1000));
    const res = await runAnalyticsPruneTick(NOW);
    expect(res.capped).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ capped: true }),
      "analytics-prune:swept",
    );
  });

  it("bounds a single tick so it cannot hold the worker slot indefinitely", async () => {
    mockFindMany.mockResolvedValue(rows(1000));
    await runAnalyticsPruneTick(NOW);
    expect(mockFindMany.mock.calls.length).toBeLessThanOrEqual(50);
  });
});
