/**
 * Sponsors route — GET/PUT the per-event sponsor list (a real table since
 * Sep 2 2026; the GET reads it and the PUT delegates to sponsor-service, which
 * owns the diff and the in-use refusal). Pins the org-scoping guards, in
 * particular the
 * null-org guard that fixes Sentry JAVASCRIPT-NEXTJS-1N: an org-independent
 * role (REVIEWER / SUBMITTER / REGISTRANT, organizationId === null) hitting the
 * GET used to reach `db.event.findFirst({ where: { organizationId: null } })`,
 * which Prisma rejects (Event.organizationId is non-nullable) → a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, saveSponsorsSpy, getSponsorsSpy } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  saveSponsorsSpy: vi.fn(),
  // The GET reads the TABLE since Sep 2 2026, so this stands in for
  // getSponsors(eventId) rather than the JSON reader it replaced.
  getSponsorsSpy: vi.fn(async (): Promise<Array<{ id: string; name: string; sortOrder: number }>> => []),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/sponsor-service", () => ({ saveSponsors: saveSponsorsSpy }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/webinar", () => ({
  SPONSOR_TIERS: ["platinum", "gold", "silver", "bronze", "partner", "exhibitor"] as const,
}));
vi.mock("@/lib/sponsors", () => ({ getSponsors: getSponsorsSpy }));
// denyReviewer is REAL (pure) — it reads session.user.role.

import { GET, PUT } from "@/app/api/events/[eventId]/sponsors/route";

const params = Promise.resolve({ eventId: "ev-1" });
const req = (body?: unknown) => ({ json: async () => body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  getSponsorsSpy.mockResolvedValue([]);
});

describe("GET /api/events/[eventId]/sponsors", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("403 (not a 500) for a null-org user — the JAVASCRIPT-NEXTJS-1N fix", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "REGISTRANT", organizationId: null } });
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
    // The query is never reached — no `organizationId: null` sent to Prisma.
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("200 + sponsors for an org-bound user", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev-1", settings: {} });
    getSponsorsSpy.mockResolvedValue([{ id: "s1", name: "Acme", sortOrder: 0 }]);
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sponsors: [{ id: "s1", name: "Acme", sortOrder: 0 }] });
    // Query bound to the caller's org.
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ev-1", organizationId: "org-1" } }),
    );
  });
});

describe("PUT /api/events/[eventId]/sponsors", () => {
  it("403 for a reviewer (denyReviewer) — never reaches the query", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "REVIEWER", organizationId: null } });
    const res = await PUT(req({ sponsors: [] }), { params });
    expect(res.status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("200 for an org admin replacing the list", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev-1", settings: {} });
    saveSponsorsSpy.mockResolvedValue({ ok: true, sponsors: [{ id: "s1", name: "Acme", sortOrder: 0 }] });
    const res = await PUT(req({ sponsors: [{ id: "s1", name: "Acme", sortOrder: 5 }] }), { params });
    expect(res.status).toBe(200);
    expect(saveSponsorsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev-1", organizationId: "org-1", source: "rest", mode: "replace" }),
    );
  });

  it("409 + the blocking rows when a dropped sponsor is still referenced", async () => {
    // The behaviour the table exists for. Before it, removing a sponsor from
    // the array succeeded and orphaned every pointer at it, which the
    // registration detail sheet still anticipates by rendering
    // "(sponsor removed)". The body carries `inUse` so the editor can say
    // WHICH sponsor and what is holding it, rather than "save failed".
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev-1", settings: {} });
    saveSponsorsSpy.mockResolvedValue({
      ok: false,
      code: "SPONSOR_IN_USE",
      message: "Cannot remove \"Abbott\"",
      inUse: [{ id: "s1", name: "Abbott", registrations: 87, promoCodes: 1 }],
    });
    const res = await PUT(req({ sponsors: [] }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SPONSOR_IN_USE");
    expect(body.inUse).toEqual([{ id: "s1", name: "Abbott", registrations: 87, promoCodes: 1 }]);
  });

  it("maps a service rejection to its own status rather than a blanket 400", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev-1", settings: {} });
    saveSponsorsSpy.mockResolvedValue({ ok: false, code: "EVENT_NOT_FOUND", message: "nope" });
    const res = await PUT(req({ sponsors: [] }), { params });
    expect(res.status).toBe(404);
  });
});
