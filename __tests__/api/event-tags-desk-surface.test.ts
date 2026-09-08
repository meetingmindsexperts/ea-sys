/**
 * GET /api/events/[eventId]/tags resolves the event on the DESK surface
 * (Sep 8, 2026).
 *
 * The route feeds the registrations list's tag filter, and that list resolves
 * the event on the desk surface (every event in the org for WEBINARS). Before
 * this pin the tags call used the default MANAGE surface, so a WEBINARS user
 * opening a CONFERENCE's registrations saw the rows while the tag filter
 * 404'd behind them (prod, 2026-09-08 05:56Z, eight lines in one minute).
 *
 * The same change widened the guard from WEBINAR_STAFF_ALLOW to
 * REGISTRATION_DESK_ALLOW: MEMBER and ONSITE could read the list but got a
 * 403 on its tag filter. Uses the REAL buildEventAccessWhere + the REAL
 * denyReviewer, so the where shape asserted here is what production sends. Mutation: dropping the
 * `{ surface: "desk" }` argument makes the WEBINARS where carry
 * `eventType: "WEBINAR"` and fails the first test.
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
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));

import { GET } from "@/app/api/events/[eventId]/tags/route";

const PARAMS = { params: Promise.resolve({ eventId: "evt1" }) };
const req = () => new Request("http://localhost/api/events/evt1/tags");
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1" });
  mockDb.registration.findMany.mockResolvedValue([]);
});

describe("tags route: desk surface", () => {
  it("WEBINARS resolves the event org-wide (no eventType bind), like the registrations list it feeds", async () => {
    mockAuth.mockResolvedValue(session("WEBINARS"));
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [] });

    const where = mockDb.event.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "evt1", organizationId: "org1" });
    expect(where).not.toHaveProperty("eventType");
  });

  it("ONSITE (assignment-gated) passes the guard; the builder keeps its assignment bind", async () => {
    mockAuth.mockResolvedValue(session("ONSITE"));
    expect((await GET(req(), PARAMS)).status).toBe(200);
    const where = mockDb.event.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "evt1", organizationId: "org1" });
    expect(where).not.toHaveProperty("eventType");
  });

  it.each(["ADMIN", "ORGANIZER", "MEMBER", "SUPER_ADMIN"])("%s stays org-scoped on the same shape", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), PARAMS)).status).toBe(200);
    const where = mockDb.event.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "evt1", organizationId: "org1" });
    expect(where).not.toHaveProperty("eventType");
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("%s is still refused before any read", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), PARAMS)).status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });
});
