/**
 * "Who is logged in right now" — last-seen presence.
 *
 * The load-bearing properties:
 *   - the online WINDOW must exceed the stamp INTERVAL, or an actively-working
 *     person flickers offline: presence is only written every 5 minutes, so at
 *     a 5-minute window someone active 4 minutes ago can have a 5-minute-old
 *     stamp and read as gone
 *   - `touchLastSeen` uses updateMany, NOT update. `update` throws P2025 when
 *     the row is gone, and a deleted account whose JWT hasn't expired would
 *     then throw on EVERY request until it did
 *   - it never throws — this sits on the authentication path
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { user: { updateMany: vi.fn(), update: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ authLogger: mockLogger, apiLogger: mockLogger }));

import {
  isOnlineNow,
  onlineSince,
  touchLastSeen,
  LAST_SEEN_STAMP_INTERVAL_MS,
  LAST_SEEN_ONLINE_WINDOW_MS,
} from "@/lib/active-users";

const NOW = new Date("2026-07-28T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.updateMany.mockResolvedValue({ count: 1 });
});

describe("the window/interval relationship", () => {
  it("keeps the online window strictly wider than the stamp interval", () => {
    // If these ever converge, an actively-working person flickers offline
    // between stamps. This is the invariant, not an arbitrary assertion.
    expect(LAST_SEEN_ONLINE_WINDOW_MS).toBeGreaterThan(LAST_SEEN_STAMP_INTERVAL_MS);
  });

  it("still counts someone whose stamp is a full interval stale", () => {
    // The worst honest case: active right now, but last written 5 min ago.
    expect(isOnlineNow(minutesAgo(LAST_SEEN_STAMP_INTERVAL_MS / 60_000), NOW)).toBe(true);
  });
});

describe("isOnlineNow", () => {
  it("counts someone seen just now", () => {
    expect(isOnlineNow(NOW, NOW)).toBe(true);
  });

  it("counts someone inside the window", () => {
    expect(isOnlineNow(minutesAgo(9), NOW)).toBe(true);
  });

  it("counts someone exactly on the boundary", () => {
    expect(isOnlineNow(new Date(NOW.getTime() - LAST_SEEN_ONLINE_WINDOW_MS), NOW)).toBe(true);
  });

  it("drops someone one second past the boundary", () => {
    expect(isOnlineNow(new Date(NOW.getTime() - LAST_SEEN_ONLINE_WINDOW_MS - 1000), NOW)).toBe(false);
  });

  it("treats never-seen as offline rather than throwing", () => {
    expect(isOnlineNow(null, NOW)).toBe(false);
    expect(isOnlineNow(undefined, NOW)).toBe(false);
  });

  it("tolerates a future timestamp from clock skew", () => {
    // A stamp slightly ahead of us is still 'recent' — it must not read as
    // offline just because two machines disagree by a second.
    expect(isOnlineNow(new Date(NOW.getTime() + 30_000), NOW)).toBe(true);
  });
});

describe("onlineSince", () => {
  it("returns exactly one window back", () => {
    expect(onlineSince(NOW).toISOString()).toBe(
      new Date(NOW.getTime() - LAST_SEEN_ONLINE_WINDOW_MS).toISOString(),
    );
  });

  it("agrees with isOnlineNow at the boundary", () => {
    const cutoff = onlineSince(NOW);
    expect(isOnlineNow(cutoff, NOW)).toBe(true);
    expect(isOnlineNow(new Date(cutoff.getTime() - 1), NOW)).toBe(false);
  });
});

describe("touchLastSeen", () => {
  it("stamps the user with updateMany", async () => {
    await touchLastSeen("user-1");

    const args = mockDb.user.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: "user-1" });
    expect(args.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("uses updateMany, never update — a deleted account must not throw per request", async () => {
    await touchLastSeen("user-1");

    expect(mockDb.user.updateMany).toHaveBeenCalled();
    // `update` would throw P2025 once the row is gone, and a JWT outlives the
    // row it names, so every request would throw until the token expired.
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the account no longer exists", async () => {
    mockDb.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(touchLastSeen("ghost")).resolves.toBeUndefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("never throws when the database is unavailable", async () => {
    mockDb.user.updateMany.mockRejectedValue(new Error("pool timeout"));

    await expect(touchLastSeen("user-1")).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "active-users:touch-failed" }),
    );
  });
});
