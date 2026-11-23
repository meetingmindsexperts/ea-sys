/**
 * What GET /api/events fetches, per caller (Nov 23, 2026).
 *
 * Every dashboard page loads this list for the header. For a signed-in member
 * of staff it was a bare `include`: whole Event rows, about 1 MB of JSON for
 * production's 55 events. These assert on the QUERY, because the fix is that
 * the columns are never fetched.
 *
 * The API-key branch is pinned the other way: it still sends whole rows. That
 * is the contract outside tools were built on (n8n, the website sync, the
 * remote MCP client), and what they read cannot be seen from this repo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EVENT_LIST_SELECT, STAFF_EVENT_LIST_SELECT } from "@/lib/event-visibility";

const { mockAuth, mockFindMany, mockValidateApiKey, mockLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockValidateApiKey: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: { event: { findMany: mockFindMany } } }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger, authLogger: mockLogger, dbLogger: mockLogger, eventLogger: mockLogger }));
vi.mock("@/lib/api-key", () => ({ validateApiKey: mockValidateApiKey }));
vi.mock("@/services/event-service", () => ({ createEvent: vi.fn() }));
// The lane is not what is under test: run the read where it stands.
vi.mock("@/lib/tenant/event-tenant", () => ({
  inOwnLane: (_gate: unknown, _req: unknown, fn: () => Promise<unknown>) => fn(),
  inHostLane: (_req: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { GET } from "@/app/api/events/route";

const get = (headers: Record<string, string> = {}, query = "") =>
  GET(new Request(`http://localhost/api/events${query}`, { headers }));

const queryOf = () => mockFindMany.mock.calls[0][0] as { select?: unknown; include?: unknown; where?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockAuth.mockResolvedValue(null);
});

describe("GET /api/events: what each caller is sent", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"])("a signed-in %s gets the trimmed list, never whole rows", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
    expect((await get()).status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(queryOf().select).toEqual(STAFF_EVENT_LIST_SELECT);
    expect(queryOf().include).toBeUndefined();
  });

  it("the trimmed list is still filtered by slug when one is given", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
    await get({}, "?slug=mehf2027");
    expect(queryOf().where).toMatchObject({ slug: "mehf2027", organizationId: "org1" });
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("a signed-in %s still gets the core facts only", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role, organizationId: null } });
    expect((await get()).status).toBe(200);
    expect(queryOf().select).toEqual(EVENT_LIST_SELECT);
    expect(queryOf().include).toBeUndefined();
  });

  it("an API key still gets whole rows with the headcounts: the outside contract is unchanged", async () => {
    mockValidateApiKey.mockResolvedValue({ organizationId: "org1", id: "key1", name: "n8n", grants: null });
    expect((await get({ "x-api-key": "k" })).status).toBe(200);
    expect(queryOf().select).toBeUndefined();
    expect(queryOf().include).toEqual({ _count: { select: { registrations: true, speakers: true } } });
  });

  it("nobody signed in and no key: 401, and nothing is read", async () => {
    expect((await get()).status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
