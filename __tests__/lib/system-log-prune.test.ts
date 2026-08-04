/**
 * system-log-prune retention sweep (Aug 4, 2026).
 *
 * SystemLog is now written on EC2 by the logger's warn+ DB stream (it was
 * Vercel-only before, which is why the /admin/infra error-trend + abuse
 * cards read zero forever). This prune keeps the table at 30 days.
 *
 * Pins the same properties as its login-event sibling: strict older-than
 * cutoff, quiet no-op, bounded select-then-delete batches, and a loud
 * capped:true when the backlog outruns one tick's budget (no silent caps).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { systemLog: { findMany: vi.fn(), deleteMany: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  runSystemLogPruneTick,
  SYSTEM_LOG_RETENTION_DAYS,
} from "@/lib/system-log-prune-worker";

const NOW = new Date("2026-08-04T04:45:00Z");

function rows(n: number, prefix = "sl") {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.systemLog.findMany.mockResolvedValue([]);
  mockDb.systemLog.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
});

describe("runSystemLogPruneTick", () => {
  it("selects strictly older than the 30-day cutoff on the timestamp column", async () => {
    await runSystemLogPruneTick(NOW);

    const where = mockDb.systemLog.findMany.mock.calls[0][0].where;
    const cutoff = where.timestamp.lt as Date;
    const expected = new Date(NOW.getTime() - SYSTEM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  it("is a clean, unlogged no-op when nothing has aged out", async () => {
    const result = await runSystemLogPruneTick(NOW);

    expect(result).toEqual({ deleted: 0, capped: false });
    expect(mockDb.systemLog.deleteMany).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("drains successive full batches until the backlog is clear", async () => {
    mockDb.systemLog.findMany
      .mockResolvedValueOnce(rows(1000, "a"))
      .mockResolvedValueOnce(rows(1000, "b"))
      .mockResolvedValueOnce(rows(3, "c"));

    const result = await runSystemLogPruneTick(NOW);

    expect(result).toEqual({ deleted: 2003, capped: false });
    expect(mockDb.systemLog.findMany).toHaveBeenCalledTimes(3);
  });

  it("reports capped:true rather than silently truncating a huge backlog", async () => {
    mockDb.systemLog.findMany.mockResolvedValue(rows(1000));

    const result = await runSystemLogPruneTick(NOW);

    expect(result.capped).toBe(true);
    expect(result.deleted).toBe(20_000);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "system-log-prune:tick", capped: true }),
      expect.any(String),
    );
  });

  it("deletes by explicit id, never by a bare date predicate", async () => {
    mockDb.systemLog.findMany.mockResolvedValueOnce(rows(3));
    await runSystemLogPruneTick(NOW);

    expect(mockDb.systemLog.deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ["sl-0", "sl-1", "sl-2"] },
    });
  });
});
