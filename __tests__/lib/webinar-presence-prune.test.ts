/**
 * Webinar presence retention (security review, Nov 5, 2026, W-06): heartbeat rows not seen for
 * 90 days are deleted, batched, never by a filter wider than the cutoff.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { webinarPresence: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runWebinarPresencePruneTick, WEBINAR_PRESENCE_RETENTION_DAYS } from "@/lib/webinar/presence-prune-worker";

const NOW = new Date("2026-11-05T04:20:00Z");
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.webinarPresence.deleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
});

describe("runWebinarPresencePruneTick", () => {
  it("selects only rows last seen before the 90-day cutoff, and deletes exactly those ids", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValueOnce(ids(3));
    const r = await runWebinarPresencePruneTick(NOW);
    const cutoff = new Date(NOW.getTime() - WEBINAR_PRESENCE_RETENTION_DAYS * 86_400_000);
    expect(mockDb.webinarPresence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lastSeenAt: { lt: cutoff } } }),
    );
    expect(mockDb.webinarPresence.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["p0", "p1", "p2"] } } });
    expect(r).toEqual({ deleted: 3, capped: false });
  });

  it("nothing past the cutoff: no delete", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValueOnce([]);
    expect(await runWebinarPresencePruneTick(NOW)).toEqual({ deleted: 0, capped: false });
    expect(mockDb.webinarPresence.deleteMany).not.toHaveBeenCalled();
  });

  it("a backlog bigger than one tick's budget is capped and says so", async () => {
    mockDb.webinarPresence.findMany.mockResolvedValue(ids(1000));
    const r = await runWebinarPresencePruneTick(NOW);
    expect(r).toEqual({ deleted: 20_000, capped: true });
  });
});
