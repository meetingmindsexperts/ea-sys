/** GET /api/analytics/traffic (Sep 25, 2026): the app-wide Analytics page's data. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockGet, mockLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findMany: vi.fn() } },
  mockGet: vi.fn(),
  mockLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => mockLimit() }));
vi.mock("@/analytics/store/org-traffic", () => ({ getOrgTraffic: mockGet }));

import { GET } from "@/app/api/analytics/traffic/route";
import { buildEventAccessWhere } from "@/lib/event-access";

const ORGANIZER = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
const req = (q = "") => new Request(`http://t/api/analytics/traffic${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ORGANIZER);
  mockDb.event.findMany.mockResolvedValue([
    { id: "evA", name: "A", slug: "a", startDate: new Date(), timezone: "Asia/Dubai" },
    { id: "evB", name: "B", slug: "b", startDate: new Date(), timezone: "Asia/Dubai" },
    { id: "evC", name: "C", slug: "c", startDate: new Date(), timezone: "Europe/London" },
  ]);
  mockGet.mockResolvedValue({ events: [], funnel: [], summary: {}, onlineRegistrations: 0, hitsRead: 0, truncated: false, timeZone: "Asia/Dubai" });
});

describe("GET /api/analytics/traffic", () => {
  it("reads the events the caller may see, through the shared access rule, in their most common time zone", async () => {
    const res = await GET(req("?days=90"));
    expect(res.status).toBe(200);
    expect(mockDb.event.findMany.mock.calls[0][0].where).toEqual(buildEventAccessWhere(ORGANIZER.user as never));
    const args = mockGet.mock.calls[0][0];
    expect(args).toMatchObject({ organizationId: "org1", timeZone: "Asia/Dubai" });
    expect(args.events.map((e: { id: string }) => e.id)).toEqual(["evA", "evB", "evC"]);
    expect(args.to.getTime() - args.from.getTime()).toBe(90 * 24 * 3600_000);
    expect((await res.json()).eventsInScope).toBe(3);
  });

  it("scopes an assignment-limited role (onsite staff) to its assigned events, not the whole organisation", async () => {
    const onsite = { user: { id: "o1", role: "ONSITE", organizationId: "org1" } };
    mockAuth.mockResolvedValueOnce(onsite);
    await GET(req());
    const where = mockDb.event.findMany.mock.calls[0][0].where;
    expect(where).toEqual(buildEventAccessWhere(onsite.user as never));
    expect(where).not.toEqual({ organizationId: "org1" });
  });

  it("defaults to 30 days and refuses any other window", async () => {
    await GET(req());
    expect(mockGet.mock.calls[0][0].to.getTime() - mockGet.mock.calls[0][0].from.getTime()).toBe(30 * 24 * 3600_000);
    for (const q of ["?days=5000", "?days=abc", "?days=14"]) expect((await GET(req(q))).status, q).toBe(400);
  });

  it("refuses the signed-out and anyone without an organisation, and rate-limits", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await GET(req())).status).toBe(401);
    mockAuth.mockResolvedValueOnce({ user: { id: "r1", role: "REVIEWER", organizationId: null } });
    expect((await GET(req())).status).toBe(403);
    mockLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    expect((await GET(req())).status).toBe(429);
  });
});
