/**
 * Sponsors route — GET/PUT the per-event sponsor list (stored in
 * Event.settings.sponsors). Pins the org-scoping guards, in particular the
 * null-org guard that fixes Sentry JAVASCRIPT-NEXTJS-1N: an org-independent
 * role (REVIEWER / SUBMITTER / REGISTRANT, organizationId === null) hitting the
 * GET used to reach `db.event.findFirst({ where: { organizationId: null } })`,
 * which Prisma rejects (Event.organizationId is non-nullable) → a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, updateEventSettingsSpy, readSponsorsSpy } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  updateEventSettingsSpy: vi.fn().mockResolvedValue(undefined),
  readSponsorsSpy: vi.fn(() => []),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: updateEventSettingsSpy }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/webinar", () => ({
  readSponsors: readSponsorsSpy,
  SPONSOR_TIERS: ["platinum", "gold", "silver", "bronze", "partner", "exhibitor"] as const,
}));
// denyReviewer is REAL (pure) — it reads session.user.role.

import { GET, PUT } from "@/app/api/events/[eventId]/sponsors/route";

const params = Promise.resolve({ eventId: "ev-1" });
const req = (body?: unknown) => ({ json: async () => body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  readSponsorsSpy.mockReturnValue([]);
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
    readSponsorsSpy.mockReturnValue([{ id: "s1", name: "Acme", sortOrder: 0 }]);
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
    const res = await PUT(req({ sponsors: [{ id: "s1", name: "Acme", sortOrder: 5 }] }), { params });
    expect(res.status).toBe(200);
    expect(updateEventSettingsSpy).toHaveBeenCalledWith("ev-1", expect.objectContaining({ sponsors: expect.any(Array) }));
    // sortOrder is re-assigned from the array index (0), not the client's 5.
    const saved = updateEventSettingsSpy.mock.calls[0][1].sponsors;
    expect(saved[0].sortOrder).toBe(0);
  });
});
