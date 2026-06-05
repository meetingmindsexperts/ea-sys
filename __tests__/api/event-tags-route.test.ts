/**
 * Unit tests for GET /api/events/[eventId]/tags — the aggregated tag
 * list that powers the searchable filter dropdown on the registrations
 * list page.
 *
 * Load-bearing contract:
 *   - returns { tags: [{ tag, count }] }
 *   - sorted by count desc, then by tag asc (deterministic order
 *     so the dropdown is stable across requests)
 *   - excludes CANCELLED registrations (their tags shouldn't surface
 *     for filter purposes; cancelled rows are not in any operator
 *     send audience)
 *   - dedupes per-attendee duplicates AND trims whitespace
 *   - 404s on a foreign event id (no enumeration oracle)
 *   - 401 / 403 for unauth / reviewer
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_user: unknown, eventId: string) => ({ id: eventId }),
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }), headers: new Map() };
    }
    return null;
  },
}));

import { GET } from "@/app/api/events/[eventId]/tags/route";

const adminSession = { user: { id: "u-1", role: "ADMIN", organizationId: "org-1" } };
const PARAMS = { params: Promise.resolve({ eventId: "evt-1" }) };

function makeReq() {
  return new Request("http://localhost/api/events/evt-1/tags");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/events/[eventId]/tags", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewers", async () => {
    mockAuth.mockResolvedValueOnce({ user: { role: "REVIEWER" } });
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(403);
  });

  it("returns 404 when event is not in caller's org (no enumeration oracle)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns empty array when no registrations have tags", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags).toEqual([]);
  });

  it("aggregates tags across registrations with correct counts", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([
      { attendee: { tags: ["vip", "speaker"] } },
      { attendee: { tags: ["vip"] } },
      { attendee: { tags: ["vip", "checked-in"] } },
      { attendee: { tags: ["speaker"] } },
    ]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags).toEqual([
      { tag: "vip", count: 3 },
      { tag: "speaker", count: 2 },
      { tag: "checked-in", count: 1 },
    ]);
  });

  it("ties are broken alphabetically (deterministic order)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([
      { attendee: { tags: ["zebra"] } },
      { attendee: { tags: ["alpha"] } },
      { attendee: { tags: ["mike"] } },
    ]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags.map((t: { tag: string }) => t.tag)).toEqual([
      "alpha",
      "mike",
      "zebra",
    ]);
  });

  it("trims whitespace and skips empty tags", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([
      { attendee: { tags: [" vip ", "vip", "", "  "] } },
    ]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags).toEqual([{ tag: "vip", count: 2 }]);
  });

  it("excludes CANCELLED registrations from the aggregation (via Prisma where)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([]);
    await GET(makeReq(), PARAMS);
    const args = mockDb.registration.findMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ notIn: ["CANCELLED"] });
  });

  it("handles null attendee gracefully (orphan-row defense)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([
      { attendee: null },
      { attendee: { tags: ["vip"] } },
    ]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags).toEqual([{ tag: "vip", count: 1 }]);
  });

  it("ignores non-string tag entries (defense vs corrupt jsonb)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findMany.mockResolvedValueOnce([
      { attendee: { tags: ["valid", 42, null, undefined, { weird: 1 }] } },
    ]);
    const res = await GET(makeReq(), PARAMS);
    const body = await res.json();
    expect(body.tags).toEqual([{ tag: "valid", count: 1 }]);
  });
});
