/**
 * Dinner RSVP roster access (review H2).
 *
 * GET /api/events/[eventId]/rsvp-invites returns each invitee's `token` — which
 * IS the impersonation credential: anyone holding it can POST the PUBLIC
 * rsvp/[token] endpoint with NO login and rewrite a named professor's
 * attendance, guest count and dietary note. It also returns the confidential
 * guest list (names, emails, dietary requirements).
 *
 * The route had no `denyReviewer` and hand-rolled `organizationId!` instead of
 * `buildEventAccessWhere`, so three org-ATTACHED populations could read it:
 *   - MEMBER   — the read-only, sponsor-side observer
 *   - ONSITE   — org-scoped here, so a desk temp assigned to Event A could pull
 *                Event B's roster (the July-7 cross-event class)
 *   - an internal-domain REGISTRANT — i.e. an attendee account
 *
 * The token stays in the payload (the console's copy-link button needs it); the
 * fix is that only the roles who actually run the dinner can reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockBuildEventAccessWhere } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpDinner: { findMany: vi.fn() },
    rsvpInvite: { findMany: vi.fn() },
  },
  mockBuildEventAccessWhere: vi.fn(),
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
vi.mock("@/lib/security", () => ({ getClientIp: () => "127.0.0.1", checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (...a: unknown[]) => mockBuildEventAccessWhere(...a),
}));
// The REAL guard — this is the thing under test.
vi.mock("@/lib/auth-guards", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-guards")>("@/lib/auth-guards");
  return actual;
});

import { GET } from "@/app/api/events/[eventId]/rsvp-invites/route";

const req = { url: "http://x/api/events/ev1/rsvp-invites" } as unknown as Request;
const params = Promise.resolve({ eventId: "ev1" });

function asRole(role: string) {
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org1", role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildEventAccessWhere.mockReturnValue({ id: "ev1", organizationId: "org1" });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.rsvpDinner.findMany.mockResolvedValue([]);
  mockDb.rsvpInvite.findMany.mockResolvedValue([]);
});

describe("H2 — who can read the RSVP roster (and therefore the invite tokens)", () => {
  it.each(["ADMIN", "SUPER_ADMIN", "ORGANIZER"])(
    "%s can read it (they run the dinner)",
    async (role) => {
      asRole(role);
      const res = await GET(req, { params });
      expect(res.status).toBe(200);
    },
  );

  it.each(["MEMBER", "ONSITE", "REGISTRANT", "REVIEWER", "SUBMITTER"])(
    "%s is refused — must not hold an invitee's impersonation token",
    async (role) => {
      asRole(role);
      const res = await GET(req, { params });
      expect(res.status).toBe(403);
      // Refused before any roster data is even fetched.
      expect(mockDb.rsvpInvite.findMany).not.toHaveBeenCalled();
    },
  );

  it("resolves the event through buildEventAccessWhere (assignment-aware), not a hand-rolled org filter", async () => {
    asRole("ORGANIZER");
    await GET(req, { params });
    expect(mockBuildEventAccessWhere).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "ev1",
    );
  });

  it("401s when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req, { params });
    expect(res.status).toBe(401);
  });
});
