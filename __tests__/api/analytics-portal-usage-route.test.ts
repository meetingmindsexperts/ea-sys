/** GET /api/analytics/portal-usage (Nov 24, 2026): the Attendee portal card's data. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUsage, mockLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findMany: vi.fn() } },
  mockUsage: vi.fn(),
  mockLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => mockLimit() }));
vi.mock("@/lib/portal-usage", () => ({ getPortalUsage: mockUsage }));

import { GET } from "@/app/api/analytics/portal-usage/route";
import { eventWhereFor, principalFromUser } from "@/lib/permissions/can";

const analyticsWhere = (u: { id: string; role: string; organizationId: string }) => eventWhereFor(principalFromUser(u), "analytics.read");
const ORGANIZER = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ORGANIZER);
  mockDb.event.findMany.mockResolvedValue([{ id: "evA", settings: {} }, { id: "evB", settings: { reviewerUserIds: ["r1"] } }]);
  mockUsage.mockResolvedValue({ roles: [], totals: { accounts: 0 }, weekly: [], signInsRecordedFrom: null });
});

describe("GET /api/analytics/portal-usage", () => {
  it("counts over the events the caller may read analytics for, through the shared access rule", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mockDb.event.findMany.mock.calls[0][0].where).toEqual(analyticsWhere(ORGANIZER.user));
    expect(mockUsage.mock.calls[0][0].map((e: { id: string }) => e.id)).toEqual(["evA", "evB"]);
    expect((await res.json()).eventsInScope).toBe(2);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("an assignment-limited role (onsite staff) counts only its assigned events", async () => {
    const onsite = { user: { id: "o1", role: "ONSITE", organizationId: "org1" } };
    mockAuth.mockResolvedValueOnce(onsite);
    await GET();
    expect(mockDb.event.findMany.mock.calls[0][0].where).toEqual(analyticsWhere(onsite.user));
  });

  it("an attendee account with an organisation (internal domain) counts no one (review of 85a9b8ce3)", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "reg1", role: "REGISTRANT", organizationId: "org1" } });
    expect((await GET()).status).toBe(200);
    expect(mockDb.event.findMany.mock.calls[0][0].where).toEqual({ id: { in: [] } });
  });

  it("refuses no session, a session with no organisation, and a caller over the limit", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValueOnce({ user: { id: "s1", role: "SUBMITTER", organizationId: null } });
    expect((await GET()).status).toBe(403);
    mockLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const limited = await GET();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("a failure is a 500, not a crash", async () => {
    mockDb.event.findMany.mockRejectedValueOnce(new Error("db down"));
    expect((await GET()).status).toBe(500);
  });
});
