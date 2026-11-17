/**
 * The stats refresh and the organisation it stamps (Event RLS step 5, review
 * of 4054ed0e, Nov 17 2026). EventStats carries a row policy on the platform,
 * so the row must carry the EVENT's organisation: read off the event, never
 * taken from whatever lane the caller happens to be in. And a refresh that
 * cannot see its event writes nothing: where row security is on, that is a
 * refresh fired outside the lane, whose counts are all zero.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    registration: { groupBy: vi.fn(), count: vi.fn() },
    speaker: { groupBy: vi.fn(), count: vi.fn() },
    abstract: { groupBy: vi.fn() },
    eventSession: { count: vi.fn() },
    track: { count: vi.fn() },
    event: { findUnique: vi.fn() },
    eventStats: { upsert: vi.fn(), findUnique: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { refreshEventStatsNow } from "@/lib/event-stats";
import { runWithTenant } from "@/lib/tenant-context";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.groupBy.mockResolvedValue([{ status: "CONFIRMED", paymentStatus: "PAID", _count: 3 }]);
  mockDb.registration.count.mockResolvedValue(1);
  mockDb.speaker.groupBy.mockResolvedValue([{ status: "CONFIRMED", _count: 2 }]);
  mockDb.speaker.count.mockResolvedValue(1);
  mockDb.abstract.groupBy.mockResolvedValue([]);
  mockDb.eventSession.count.mockResolvedValue(4);
  mockDb.track.count.mockResolvedValue(2);
  mockDb.event.findUnique.mockResolvedValue({ organizationId: "org-event" });
  mockDb.eventStats.upsert.mockResolvedValue({});
});

describe("refreshEventStats: the organisation on the row", () => {
  it("stamps the EVENT's organisation, on create and on update", async () => {
    await refreshEventStatsNow("ev1");
    expect(mockDb.event.findUnique).toHaveBeenCalledWith({ where: { id: "ev1" }, select: { organizationId: true } });
    const args = mockDb.eventStats.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ eventId: "ev1" });
    expect(args.create).toMatchObject({ eventId: "ev1", organizationId: "org-event", totalRegistrations: 3, totalSpeakers: 2, totalSessions: 4 });
    // The update stamps too: a row from before the column existed is healed by its next refresh.
    expect(args.update).toMatchObject({ organizationId: "org-event", totalRegistrations: 3 });
    expect(args.update).not.toHaveProperty("eventId");
  });

  it("never takes the organisation from the lane it is called in", async () => {
    await runWithTenant("org-some-other-lane", () => refreshEventStatsNow("ev1"));
    expect(mockDb.eventStats.upsert.mock.calls[0][0].create.organizationId).toBe("org-event");
    await refreshEventStatsNow("ev1");
    expect(mockDb.eventStats.upsert.mock.calls[1][0].create.organizationId).toBe("org-event");
  });

  it("writes nothing when the event cannot be seen, and says so", async () => {
    // A deleted event, or a refresh outside its organisation's lane where row security is on:
    // every count would be zero, and zeros must not land on the dashboard.
    mockDb.event.findUnique.mockResolvedValue(null);
    await expect(refreshEventStatsNow("ev-gone")).resolves.toBeUndefined();
    expect(mockDb.eventStats.upsert).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith({ msg: "event-stats:refresh-skipped-event-not-visible", eventId: "ev-gone" });
  });
});
