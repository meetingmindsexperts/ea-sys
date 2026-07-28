/**
 * GET /api/organization/active-users
 *
 * Same ADMIN+ boundary as the sign-in history it sits beside, and the same
 * org scoping — "who is working right now" is staff-monitoring data, so
 * ORGANIZER is the case that matters here just as it does there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { user: { findMany: vi.fn() } },
  mockRateLimit: vi.fn(),
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
  authLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (session: { user?: { organizationId?: string } } | null) =>
    session?.user?.organizationId
      ? { orgId: session.user.organizationId }
      : { error: { status: 403, json: async () => ({ error: "Forbidden" }) } },
}));

import { GET } from "@/app/api/organization/active-users/route";

function session(role: string, organizationId: string | null = "org-1", id = "user-1") {
  return { user: { id, role, organizationId } };
}

const nowish = () => new Date();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 599, retryAfterSeconds: 3600 });
  mockDb.user.findMany.mockResolvedValue([
    { id: "user-1", firstName: "Ada", lastName: "L", email: "ada@x.com", role: "ADMIN", lastSeenAt: nowish() },
    { id: "user-2", firstName: "Bob", lastName: "M", email: "bob@x.com", role: "ORGANIZER", lastSeenAt: minutesAgo(90) },
    { id: "user-3", firstName: "Cy", lastName: "N", email: "cy@x.com", role: "ORGANIZER", lastSeenAt: null },
  ]);
});

describe("access boundary", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
  });

  it.each(["SUPER_ADMIN", "ADMIN"])("allows %s", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET()).status).toBe(200);
  });

  it.each(["ORGANIZER", "MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER"])(
    "403s %s and runs no query",
    async (role) => {
      mockAuth.mockResolvedValue(session(role));
      expect((await GET()).status).toBe(403);
      expect(mockDb.user.findMany).not.toHaveBeenCalled();
    },
  );

  it("403s an org-independent admin", async () => {
    mockAuth.mockResolvedValue(session("ADMIN", null));
    expect((await GET()).status).toBe(403);
  });

  it("429s past the rate limit, before the query", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect((await GET()).status).toBe(429);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
  });
});

describe("scoping and shape", () => {
  it("scopes to the caller's organization", async () => {
    await GET();
    expect(mockDb.user.findMany.mock.calls[0][0].where).toEqual({ organizationId: "org-1" });
  });

  it("never selects the password hash", async () => {
    await GET();
    const select = mockDb.user.findMany.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.lastSeenAt).toBe(true);
  });

  it("orders most-recently-active first with never-seen last", async () => {
    await GET();
    expect(mockDb.user.findMany.mock.calls[0][0].orderBy[0]).toEqual({
      lastSeenAt: { sort: "desc", nulls: "last" },
    });
  });

  it("marks who is online and counts them", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      users: Array<{ id: string; isOnline: boolean; isYou: boolean }>;
      onlineCount: number;
    };

    expect(body.users.find((u) => u.id === "user-1")?.isOnline).toBe(true);
    expect(body.users.find((u) => u.id === "user-2")?.isOnline).toBe(false);
    // Never seen is offline, not an error.
    expect(body.users.find((u) => u.id === "user-3")?.isOnline).toBe(false);
    expect(body.onlineCount).toBe(1);
  });

  it("flags the caller's own row so the UI can label it", async () => {
    const res = await GET();
    const body = (await res.json()) as { users: Array<{ id: string; isYou: boolean }> };
    expect(body.users.find((u) => u.id === "user-1")?.isYou).toBe(true);
    expect(body.users.find((u) => u.id === "user-2")?.isYou).toBe(false);
  });

  it("lists never-seen accounts rather than hiding them", async () => {
    // An account unused since this shipped is information, not a row to drop.
    const res = await GET();
    const body = (await res.json()) as { users: Array<{ id: string }> };
    expect(body.users.map((u) => u.id)).toContain("user-3");
  });

  it("reports the window so the UI doesn't hardcode it", async () => {
    const res = await GET();
    const body = (await res.json()) as { onlineWindowMinutes: number };
    expect(body.onlineWindowMinutes).toBe(10);
  });

  it("reports when tracking began, so a null can be explained not guessed", async () => {
    // Without this the UI renders "Never" against every colleague on day one,
    // which is indistinguishable from "this account has never been used".
    const res = await GET();
    const body = (await res.json()) as { trackingSince: string };
    expect(Number.isNaN(Date.parse(body.trackingSince))).toBe(false);
  });
});

describe("failure handling", () => {
  it("500s when the query fails", async () => {
    mockDb.user.findMany.mockRejectedValue(new Error("db down"));
    expect((await GET()).status).toBe(500);
  });
});
