/**
 * email-log-prune worker (src/lib/email-log-prune-worker.ts) — retention for
 * the sent-email audit bodies. Since July 16, 2026 every send stores its
 * rendered HTML on EmailLog.htmlBody; this job nulls bodies older than
 * EMAIL_BODY_RETENTION_DAYS while keeping the log row itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    emailLog: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { runEmailLogPruneTick, EMAIL_BODY_RETENTION_DAYS } from "@/lib/email-log-prune-worker";

const NOW = new Date("2026-07-16T03:45:00Z");

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): an unconsumed mockResolvedValueOnce
  // from a short-circuiting test must not leak into the next one.
  vi.resetAllMocks();
});

describe("runEmailLogPruneTick", () => {
  it("no-ops when nothing is past the retention cutoff", async () => {
    mockDb.emailLog.findMany.mockResolvedValue([]);
    const res = await runEmailLogPruneTick(NOW);
    expect(res).toEqual({ pruned: 0, capped: false });
    expect(mockDb.emailLog.updateMany).not.toHaveBeenCalled();
  });

  it("prunes only rows older than the cutoff AND still carrying a body — and only nulls htmlBody", async () => {
    mockDb.emailLog.findMany
      .mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }])
      .mockResolvedValueOnce([]);
    mockDb.emailLog.updateMany.mockResolvedValue({ count: 2 });

    const res = await runEmailLogPruneTick(NOW);

    expect(res).toEqual({ pruned: 2, capped: false });
    const expectedCutoff = new Date(NOW.getTime() - EMAIL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(mockDb.emailLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lt: expectedCutoff }, htmlBody: { not: null } },
      }),
    );
    // The log ROW is kept — only the body is nulled.
    expect(mockDb.emailLog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["e1", "e2"] } },
      data: { htmlBody: null },
    });
  });

  it("loops batches until the backlog is drained", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }));
    mockDb.emailLog.findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: "tail" }]);
    mockDb.emailLog.updateMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });

    const res = await runEmailLogPruneTick(NOW);
    expect(res).toEqual({ pruned: 1001, capped: false });
    expect(mockDb.emailLog.updateMany).toHaveBeenCalledTimes(2);
  });

  it("caps at the per-tick budget and REPORTS the cap (no silent truncation)", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `b${i}` }));
    mockDb.emailLog.findMany.mockResolvedValue(full); // never drains
    mockDb.emailLog.updateMany.mockResolvedValue({ count: 1000 });

    const res = await runEmailLogPruneTick(NOW);
    expect(res.capped).toBe(true);
    expect(res.pruned).toBe(20_000); // MAX_BATCHES_PER_TICK × BATCH_SIZE
    expect(mockDb.emailLog.updateMany).toHaveBeenCalledTimes(20);
  });
});
