/**
 * login-event-prune retention sweep.
 *
 * Unlike email-log-prune (which nulls a column and keeps the row), this
 * DELETES: an expired sign-in record stripped of its address, location and
 * user carries nothing worth the storage — and it holds personal data that
 * shouldn't accumulate into a permanent movement log of the team.
 *
 * The properties worth pinning are the two that would go unnoticed in
 * production: that the cutoff is a strict "older than", and that a backlog
 * bigger than one tick's budget is reported rather than silently truncated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { loginEvent: { findMany: vi.fn(), deleteMany: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  runLoginEventPruneTick,
  LOGIN_EVENT_RETENTION_DAYS,
} from "@/lib/login-event-prune-worker";

const NOW = new Date("2026-07-28T04:15:00Z");

function rows(n: number, prefix = "le") {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.loginEvent.findMany.mockResolvedValue([]);
  mockDb.loginEvent.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
});

describe("runLoginEventPruneTick", () => {
  it("selects strictly older than the retention cutoff", async () => {
    await runLoginEventPruneTick(NOW);

    const where = mockDb.loginEvent.findMany.mock.calls[0][0].where;
    const cutoff = where.createdAt.lt as Date;
    const expected = new Date(NOW.getTime() - LOGIN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  it("is a clean no-op when nothing has aged out", async () => {
    const result = await runLoginEventPruneTick(NOW);

    expect(result).toEqual({ deleted: 0, capped: false });
    expect(mockDb.loginEvent.deleteMany).not.toHaveBeenCalled();
    // Nothing happened, so nothing is logged — a daily no-op shouldn't be noise.
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("deletes a partial batch and stops", async () => {
    mockDb.loginEvent.findMany.mockResolvedValueOnce(rows(40));

    const result = await runLoginEventPruneTick(NOW);

    expect(result).toEqual({ deleted: 40, capped: false });
    expect(mockDb.loginEvent.findMany).toHaveBeenCalledTimes(1);
  });

  it("drains successive full batches until the backlog is clear", async () => {
    mockDb.loginEvent.findMany
      .mockResolvedValueOnce(rows(1000, "a"))
      .mockResolvedValueOnce(rows(1000, "b"))
      .mockResolvedValueOnce(rows(7, "c"));

    const result = await runLoginEventPruneTick(NOW);

    expect(result).toEqual({ deleted: 2007, capped: false });
    expect(mockDb.loginEvent.findMany).toHaveBeenCalledTimes(3);
  });

  it("reports capped:true rather than silently truncating a huge backlog", async () => {
    // Always full batches — the backlog outruns this tick's budget.
    mockDb.loginEvent.findMany.mockResolvedValue(rows(1000));

    const result = await runLoginEventPruneTick(NOW);

    expect(result.capped).toBe(true);
    expect(result.deleted).toBe(20_000);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "login-event-prune:tick", capped: true }),
    );
  });

  it("deletes by explicit id, never by a bare date predicate", async () => {
    mockDb.loginEvent.findMany.mockResolvedValueOnce(rows(3));
    await runLoginEventPruneTick(NOW);

    // Select-then-delete keeps each statement's lock footprint bounded on the
    // shared production database.
    expect(mockDb.loginEvent.deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ["le-0", "le-1", "le-2"] },
    });
  });
});
