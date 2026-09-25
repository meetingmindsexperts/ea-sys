/** getOrgTraffic (Sep 25, 2026): the app-wide read, scoped to the events the caller may see. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { analyticsEvent: { findMany: vi.fn(), findFirst: vi.fn() }, registration: { groupBy: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getOrgTraffic } from "@/analytics/store/org-traffic";

const from = new Date("2026-09-20T00:00:00Z");
const to = new Date("2026-09-25T12:00:00Z");
const events = [
  { id: "evA", name: "Alpha Summit", slug: "alpha", startDate: new Date("2027-01-10") },
  { id: "evB", name: "Beta Forum", slug: "beta", startDate: new Date("2027-02-10") },
  { id: "evC", name: "Quiet Day", slug: "quiet", startDate: new Date("2027-03-10") },
];
const pv = (eventId: string, v: string, routePattern: string, referrerHost: string | null = null) => ({
  eventId, name: "pageview", path: "/e/x", routePattern, visitorHash: v, sessionHash: `s-${v}`, referrerHost,
  deviceType: "desktop", durationMs: null, scrollDepth: null, createdAt: new Date("2026-09-24T09:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Measurement began well before these windows unless a test says otherwise.
  mockDb.analyticsEvent.findFirst.mockResolvedValue({ createdAt: new Date("2026-08-20T00:00:00Z") });
  mockDb.analyticsEvent.findMany.mockResolvedValue([
    pv("evA", "a1", "/e/:slug/register/:category", "alpha.org"),
    pv("evA", "a2", "/e/:slug/register/:category", "alpha.org"),
    pv("evA", "a3", "/e/:slug/agenda"),
    pv("evB", "b1", "/e/:slug/register"),
  ]);
  mockDb.registration.groupBy.mockResolvedValue([
    { eventId: "evA", _count: { _all: 2 } },
    { eventId: "evB", _count: { _all: 1 } },
  ]);
});

describe("getOrgTraffic", () => {
  it("reads only the given events, in the organisation and the window", async () => {
    await getOrgTraffic({ organizationId: "org1", events, from, to, timeZone: "Asia/Dubai" });
    expect(mockDb.analyticsEvent.findMany.mock.calls[0][0].where).toEqual({
      organizationId: "org1", eventId: { in: ["evA", "evB", "evC"] }, createdAt: { gte: from, lte: to },
    });
    expect(mockDb.registration.groupBy.mock.calls[0][0].where).toMatchObject({
      eventId: { in: ["evA", "evB", "evC"] }, createdSource: "PUBLIC_REGISTER", createdAt: { gte: from, lte: to },
    });
  });

  it("builds one row per active event with conversion and top source, busiest first, dropping silent events", async () => {
    const t = await getOrgTraffic({ organizationId: "org1", events, from, to, timeZone: "Asia/Dubai" });
    expect(t.events.map((e) => e.eventId)).toEqual(["evA", "evB"]);
    expect(t.events[0]).toMatchObject({ name: "Alpha Summit", visitors: 3, registerVisitors: 2, onlineRegistrations: 2, topSource: "alpha.org" });
    expect(t.events[0].conversionRate).toBeCloseTo(2 / 3);
    expect(t.onlineRegistrations).toBe(3);
    expect(t.funnel.map((s) => s.count)).toEqual([4, 3, 3]);
  });

  it("reads nothing at all for a caller with no events", async () => {
    const t = await getOrgTraffic({ organizationId: "org1", events: [], from, to, timeZone: "UTC" });
    expect(t.events).toEqual([]);
    expect(mockDb.analyticsEvent.findMany).not.toHaveBeenCalled();
    expect(mockDb.registration.groupBy).not.toHaveBeenCalled();
  });

  it("counts registrations only from when measurement began, so a long window cannot compare visits with pre-tracking sign-ups", async () => {
    const early = new Date("2026-06-27T00:00:00Z");
    await getOrgTraffic({ organizationId: "org1", events, from: early, to, timeZone: "Asia/Dubai" });
    expect(mockDb.registration.groupBy.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date("2026-08-20T00:00:00Z"), lte: to });
    expect(mockDb.analyticsEvent.findFirst.mock.calls[0][0]).toMatchObject({ where: { organizationId: "org1" }, orderBy: { createdAt: "asc" } });
  });
});
