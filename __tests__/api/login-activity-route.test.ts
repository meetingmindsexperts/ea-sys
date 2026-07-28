/**
 * GET /api/organization/login-activity
 *
 * What these tests hold in place:
 *   - the boundary is ADMIN+, NARROWER than every neighbouring settings tab.
 *     ORGANIZER is the case that matters: it passes `denyReviewer` and owns
 *     events, so any guard borrowed from a sibling route would have let it read
 *     when the finance admin last signed in and from which address.
 *   - the query is org-scoped. Sign-in records name real people at real IPs;
 *     a cross-tenant leak here is a different class of problem from leaking a
 *     session list.
 *   - geo is failure-isolated: the list still returns when the provider is
 *     down, and a failed lookup is NOT stamped as resolved (so it retries).
 *   - the rate limit fires before any query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockRateLimit, mockResolveIp, mockGeoEnabled } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    loginEvent: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
  mockRateLimit: vi.fn(),
  mockResolveIp: vi.fn(),
  mockGeoEnabled: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));
vi.mock("@/lib/login-geo", () => ({
  resolveIpLocation: (...a: unknown[]) => mockResolveIp(...a),
  isGeoEnabled: () => mockGeoEnabled(),
}));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (session: { user?: { organizationId?: string } } | null) =>
    session?.user?.organizationId
      ? { orgId: session.user.organizationId }
      : { error: { status: 403, json: async () => ({ error: "Forbidden" }) } },
}));

import { GET } from "@/app/api/organization/login-activity/route";

function session(role: string, organizationId: string | null = "org-1") {
  return { user: { id: "user-1", role, organizationId } };
}

function req(query = "") {
  return new Request(`http://localhost/api/organization/login-activity${query}`);
}

const ROW = {
  id: "le-1",
  email: "admin@example.com",
  outcome: "SUCCESS",
  surface: "DASHBOARD",
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0",
  geoCity: null,
  geoCountry: null,
  geoResolvedAt: null,
  createdAt: new Date("2026-07-28T09:00:00Z"),
  user: { id: "user-9", firstName: "Ada", lastName: "Lovelace", role: "ADMIN" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 119, retryAfterSeconds: 3600 });
  mockGeoEnabled.mockReturnValue(true);
  mockResolveIp.mockResolvedValue({ ok: true, location: { city: "Dubai", country: "UAE" } });
  mockDb.loginEvent.count.mockResolvedValue(1);
  mockDb.loginEvent.findMany.mockResolvedValue([ROW]);
  mockDb.loginEvent.updateMany.mockResolvedValue({ count: 1 });
});

describe("access boundary", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(mockDb.loginEvent.findMany).not.toHaveBeenCalled();
  });

  it.each(["SUPER_ADMIN", "ADMIN"])("allows %s", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req())).status).toBe(200);
  });

  it.each([
    "ORGANIZER", "MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER",
  ])("403s %s and runs no query", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockDb.loginEvent.findMany).not.toHaveBeenCalled();
    expect(mockDb.loginEvent.count).not.toHaveBeenCalled();
  });

  it("403s an org-independent admin (no org to scope to)", async () => {
    mockAuth.mockResolvedValue(session("ADMIN", null));
    expect((await GET(req())).status).toBe(403);
  });

  it("429s past the rate limit, before touching the database", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 300 });
    expect((await GET(req())).status).toBe(429);
    expect(mockDb.loginEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("scoping and filters", () => {
  it("scopes every query to the caller's organization", async () => {
    await GET(req());
    const where = mockDb.loginEvent.findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe("org-1");
    expect(mockDb.loginEvent.count.mock.calls[0][0].where.organizationId).toBe("org-1");
  });

  it("narrows to successes only", async () => {
    await GET(req("?outcome=success"));
    expect(mockDb.loginEvent.findMany.mock.calls[0][0].where.outcome).toBe("SUCCESS");
  });

  it("narrows to every non-success for the failed filter", async () => {
    await GET(req("?outcome=failed"));
    // `not: SUCCESS` rather than a hand-listed set, so a future outcome value
    // is included automatically instead of silently vanishing from the view.
    expect(mockDb.loginEvent.findMany.mock.calls[0][0].where.outcome).toEqual({ not: "SUCCESS" });
  });

  it("applies no outcome predicate for the default filter", async () => {
    await GET(req());
    expect(mockDb.loginEvent.findMany.mock.calls[0][0].where.outcome).toBeUndefined();
  });

  it("narrows to one person when asked", async () => {
    await GET(req("?userId=user-9"));
    expect(mockDb.loginEvent.findMany.mock.calls[0][0].where.userId).toBe("user-9");
  });

  it("400s an out-of-range window rather than silently clamping it", async () => {
    expect((await GET(req("?days=99999"))).status).toBe(400);
  });

  it("400s an unknown outcome instead of dropping the predicate and widening", async () => {
    expect((await GET(req("?outcome=maybe"))).status).toBe(400);
  });

  it("paginates newest-first", async () => {
    await GET(req("?page=3&limit=10"));
    const args = mockDb.loginEvent.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });
});

describe("lazy geo resolution", () => {
  it("resolves an unresolved address and writes the answer back", async () => {
    const res = await GET(req());
    const body = (await res.json()) as { events: Array<{ geoCity: string | null }> };

    expect(mockResolveIp).toHaveBeenCalledWith("203.0.113.7");
    expect(body.events[0].geoCity).toBe("Dubai");

    // Written back org-scoped, and only over rows not already resolved.
    const update = mockDb.loginEvent.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({
      organizationId: "org-1",
      ipAddress: "203.0.113.7",
      geoResolvedAt: null,
    });
  });

  it("resolves a repeated address once per request", async () => {
    mockDb.loginEvent.findMany.mockResolvedValue([
      ROW,
      { ...ROW, id: "le-2" },
      { ...ROW, id: "le-3" },
    ]);
    await GET(req());
    expect(mockResolveIp).toHaveBeenCalledTimes(1);
  });

  it("does not re-resolve a row that already has an answer", async () => {
    mockDb.loginEvent.findMany.mockResolvedValue([
      { ...ROW, geoCity: "Muscat", geoCountry: "Oman", geoResolvedAt: new Date() },
    ]);
    await GET(req());
    expect(mockResolveIp).not.toHaveBeenCalled();
  });

  it("does not stamp a FAILED lookup as resolved, so it retries next time", async () => {
    mockResolveIp.mockResolvedValue({ ok: false });
    const res = await GET(req());
    const body = (await res.json()) as { events: Array<{ geoResolvedAt: string | null }> };

    expect(mockDb.loginEvent.updateMany).not.toHaveBeenCalled();
    expect(body.events[0].geoResolvedAt).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still returns the list when geo resolution blows up entirely", async () => {
    mockResolveIp.mockRejectedValue(new Error("provider on fire"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("makes no lookups and reports the fact when geo is switched off", async () => {
    mockGeoEnabled.mockReturnValue(false);
    const res = await GET(req());
    const body = (await res.json()) as { geoEnabled: boolean };

    expect(mockResolveIp).not.toHaveBeenCalled();
    expect(body.geoEnabled).toBe(false);
  });

  it("skips rows with no address at all", async () => {
    mockDb.loginEvent.findMany.mockResolvedValue([{ ...ROW, ipAddress: null }]);
    await GET(req());
    expect(mockResolveIp).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("500s and logs when the query itself fails", async () => {
    mockDb.loginEvent.findMany.mockRejectedValue(new Error("db down"));
    expect((await GET(req())).status).toBe(500);
  });
});
