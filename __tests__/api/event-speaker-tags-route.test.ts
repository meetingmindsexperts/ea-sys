/**
 * Unit tests for GET /api/events/[eventId]/speakers/tags — mirror of
 * the event-tags-route tests but for the Speaker.tags surface. Same
 * load-bearing contract:
 *   - returns { tags: [{ tag, count }] }
 *   - sorted by count desc, then tag asc
 *   - trims whitespace + skips empty + ignores non-strings
 *   - 401 / 403 / 404 auth + ownership cases
 *
 * Why a separate test file instead of parameterizing the existing one:
 * the routes have subtly different code paths (Speaker.findMany vs
 * Registration.findMany→attendee.tags) that should be exercised
 * independently. A regression in one shouldn't quietly pass via the
 * other's coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn() },
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

import { GET } from "@/app/api/events/[eventId]/speakers/tags/route";

const adminSession = { user: { id: "u-1", role: "ADMIN", organizationId: "org-1" } };
const PARAMS = { params: Promise.resolve({ eventId: "evt-1" }) };

function makeReq() {
  return new Request("http://localhost/api/events/evt-1/speakers/tags");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/events/[eventId]/speakers/tags", () => {
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

  it("returns 404 when event is not in caller's org", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns empty array when no speakers have tags", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.speaker.findMany.mockResolvedValueOnce([]);
    const res = await GET(makeReq(), PARAMS);
    expect((await res.json()).tags).toEqual([]);
  });

  it("aggregates tags across speakers with correct counts", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.speaker.findMany.mockResolvedValueOnce([
      { tags: ["keynote", "physician"] },
      { tags: ["keynote"] },
      { tags: ["panelist"] },
    ]);
    const res = await GET(makeReq(), PARAMS);
    expect((await res.json()).tags).toEqual([
      { tag: "keynote", count: 2 },
      { tag: "panelist", count: 1 },
      { tag: "physician", count: 1 },
    ]);
  });

  it("trims whitespace and skips empty tags + ignores non-strings", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.speaker.findMany.mockResolvedValueOnce([
      { tags: [" keynote ", "", "  ", 42, null] },
    ]);
    const res = await GET(makeReq(), PARAMS);
    expect((await res.json()).tags).toEqual([{ tag: "keynote", count: 1 }]);
  });
});
