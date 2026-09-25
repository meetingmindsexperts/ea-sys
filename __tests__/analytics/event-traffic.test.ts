/**
 * getEventTraffic: the funnel's last step counts registrations made through
 * the PUBLIC FORM within the SAME WINDOW as the hits (Sep 25, 2026). It used to
 * count every registration the event ever had, which set CSV imports and
 * pre-tracking rows against one window's visitors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { analyticsEvent: { findMany: vi.fn() }, registration: { count: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getEventTraffic } from "@/analytics/store/event-traffic";

const from = new Date("2026-09-01T00:00:00Z");
const to = new Date("2026-09-25T23:59:59Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.analyticsEvent.findMany.mockResolvedValue([
    { name: "pageview", path: "/e/x/register/d", routePattern: "/e/:slug/register/:category", visitorHash: "a", sessionHash: "s1", referrerHost: "example.org", deviceType: "desktop", durationMs: null, scrollDepth: null, createdAt: new Date("2026-09-10T10:00:00Z") },
    { name: "pageview", path: "/e/x/agenda", routePattern: "/e/:slug/agenda", visitorHash: "b", sessionHash: "s2", referrerHost: null, deviceType: "mobile", durationMs: null, scrollDepth: null, createdAt: new Date("2026-09-11T10:00:00Z") },
  ]);
  mockDb.registration.count.mockResolvedValue(1);
});

describe("getEventTraffic", () => {
  it("counts only public-form registrations inside the window for the funnel's last step", async () => {
    const t = await getEventTraffic({ eventId: "ev1", organizationId: "org1", from, to, timeZone: "Asia/Dubai" });
    const where = mockDb.registration.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ eventId: "ev1", createdSource: "PUBLIC_REGISTER", createdAt: { gte: from, lte: to } });
    expect(where.status).toBeUndefined();
    expect(t.funnel.map((s) => s.count)).toEqual([2, 1, 1]);
  });

  it("reads hits for the same window", async () => {
    await getEventTraffic({ eventId: "ev1", organizationId: "org1", from, to });
    expect(mockDb.analyticsEvent.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", createdAt: { gte: from, lte: to } });
  });
});
