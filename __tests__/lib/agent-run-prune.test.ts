/**
 * agent-run-prune retention sweep.
 *
 * Same shape as login-event-prune: DELETES runs older than the cutoff (their
 * steps go through the FK cascade). The two properties worth pinning are the
 * ones that would go unnoticed in production: the cutoff is a strict "older
 * than" on startedAt, and a backlog bigger than one tick's budget is reported
 * rather than silently truncated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { agentRun: { findMany: vi.fn(), deleteMany: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  runAgentRunPruneTick,
  AGENT_RUN_RETENTION_DAYS,
} from "@/lib/agent-run-prune-worker";

const NOW = new Date("2026-07-28T04:15:00Z");

function rows(n: number, prefix = "ar") {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.agentRun.findMany.mockResolvedValue([]);
  mockDb.agentRun.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
});

describe("runAgentRunPruneTick", () => {
  it("selects strictly older than the retention cutoff", async () => {
    await runAgentRunPruneTick(NOW);

    const where = mockDb.agentRun.findMany.mock.calls[0][0].where;
    const cutoff = where.startedAt.lt as Date;
    const expected = new Date(NOW.getTime() - AGENT_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  it("is a clean no-op when nothing has aged out", async () => {
    const result = await runAgentRunPruneTick(NOW);

    expect(result).toEqual({ deleted: 0, capped: false });
    expect(mockDb.agentRun.deleteMany).not.toHaveBeenCalled();
    // Nothing happened, so nothing is logged — a daily no-op shouldn't be noise.
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("deletes a partial batch and stops", async () => {
    mockDb.agentRun.findMany.mockResolvedValueOnce(rows(40));

    const result = await runAgentRunPruneTick(NOW);

    expect(result).toEqual({ deleted: 40, capped: false });
    expect(mockDb.agentRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("drains successive full batches until the backlog is clear", async () => {
    mockDb.agentRun.findMany
      .mockResolvedValueOnce(rows(1000, "a"))
      .mockResolvedValueOnce(rows(1000, "b"))
      .mockResolvedValueOnce(rows(7, "c"));

    const result = await runAgentRunPruneTick(NOW);

    expect(result).toEqual({ deleted: 2007, capped: false });
    expect(mockDb.agentRun.findMany).toHaveBeenCalledTimes(3);
  });

  it("reports capped:true rather than silently truncating a huge backlog", async () => {
    // Always full batches — the backlog outruns this tick's budget.
    mockDb.agentRun.findMany.mockResolvedValue(rows(1000));

    const result = await runAgentRunPruneTick(NOW);

    expect(result.capped).toBe(true);
    expect(result.deleted).toBe(20_000);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "agent-run-prune:tick", capped: true }),
    );
  });

  it("deletes by explicit id, never by a bare date predicate", async () => {
    mockDb.agentRun.findMany.mockResolvedValueOnce(rows(3));
    await runAgentRunPruneTick(NOW);

    // Select-then-delete keeps each statement's lock footprint bounded on the
    // shared production database.
    expect(mockDb.agentRun.deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ["ar-0", "ar-1", "ar-2"] },
    });
  });
});
