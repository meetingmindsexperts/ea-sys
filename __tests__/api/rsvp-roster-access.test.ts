/**
 * RSVP roster access (review H2).
 *
 * GET /api/events/[eventId]/rsvp-campaigns/[campaignId]/invites returns each
 * invitee's `token` — which IS the impersonation credential: anyone holding it
 * can POST the PUBLIC rsvp/[token] endpoint with NO login and rewrite a named
 * professor's attendance, guest count and dietary note. It also returns the
 * confidential guest list (names, emails, dietary requirements).
 *
 * The route had no `denyReviewer` and hand-rolled `organizationId!` instead of
 * `buildEventAccessWhere`, so three org-ATTACHED populations could read it:
 *   - MEMBER   — the read-only, sponsor-side observer
 *   - ONSITE   — org-scoped here, so a desk temp assigned to Event A could pull
 *                Event B's roster (the July-7 cross-event class)
 *   - an internal-domain REGISTRANT — i.e. an attendee account
 *
 * The token stays in the payload (the console's copy-link button needs it); the
 * fix is that only the roles who actually run the RSVP can reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockBuildEventAccessWhere } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpCampaign: { findFirst: vi.fn(), findMany: vi.fn() },
    rsvpItem: { findMany: vi.fn() },
    rsvpInvite: { findMany: vi.fn(), groupBy: vi.fn() },
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

import { GET } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route";
import { GET as campaignsGet } from "@/app/api/events/[eventId]/rsvp-campaigns/route";
import { ROSTER_PII_AGENT_TOOLS } from "@/lib/agent/tools/_shared";

const req = { url: "http://x/api/events/ev1/rsvp-campaigns/c1/invites" } as unknown as Request;
const params = Promise.resolve({ eventId: "ev1", campaignId: "c1" });
const listParams = Promise.resolve({ eventId: "ev1" });

const CAMPAIGN = {
  id: "c1",
  eventId: "ev1",
  organizationId: "org1",
  name: "Gala Dinner",
  description: null,
  selectionMode: "MULTI",
  allowGuests: true,
  collectDietary: true,
  isActive: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function asRole(role: string) {
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org1", role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildEventAccessWhere.mockReturnValue({ id: "ev1", organizationId: "org1" });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.rsvpCampaign.findFirst.mockResolvedValue(CAMPAIGN);
  mockDb.rsvpCampaign.findMany.mockResolvedValue([]);
  mockDb.rsvpItem.findMany.mockResolvedValue([]);
  mockDb.rsvpInvite.findMany.mockResolvedValue([]);
  mockDb.rsvpInvite.groupBy.mockResolvedValue([]);
});

describe("H2 — who can read the RSVP roster (and therefore the invite tokens)", () => {
  it.each(["ADMIN", "SUPER_ADMIN", "ORGANIZER"])(
    "%s can read it (they run the RSVP)",
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

  it("binds the campaign to the URL's event — a foreign campaign id 404s, not 200", async () => {
    // loadRsvpCampaign filters { id, eventId }; a campaign belonging to another
    // event resolves to null even for a caller who legitimately holds both.
    asRole("ORGANIZER");
    mockDb.rsvpCampaign.findFirst.mockResolvedValue(null);
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
    expect(mockDb.rsvpInvite.findMany).not.toHaveBeenCalled();
  });

  it("scopes the roster to the CAMPAIGN, never the whole event", async () => {
    // The bug this guards: reading invites by eventId would merge the workshop
    // audience into the dinner roster (and its headcounts).
    asRole("ORGANIZER");
    await GET(req, { params });
    const where = mockDb.rsvpInvite.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ campaignId: "c1" });
    expect(where.eventId).toBeUndefined();
  });
});

// ── R2 M4 — the sibling campaign list must carry the same boundary ────
describe("R2 M4 — GET /rsvp-campaigns aligns with the roster GET's access model", () => {
  it.each(["MEMBER", "ONSITE", "CRM_USER", "REGISTRANT"])(
    "%s is refused (the predecessor route had no role guard at all)",
    async (role) => {
      asRole(role);
      const res = await campaignsGet(req, { params: listParams });
      expect(res.status).toBe(403);
    },
  );

  it("ORGANIZER reads via buildEventAccessWhere, not a hand-rolled org filter", async () => {
    asRole("ORGANIZER");
    const res = await campaignsGet(req, { params: listParams });
    expect(res.status).toBe(200);
    expect(mockBuildEventAccessWhere).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "ev1",
    );
  });
});

// ── R2 M5 — the agent surface must agree with the roster policy ──────
describe("R2 M5 — list_rsvps is in the MEMBER-refused agent set", () => {
  it("ROSTER_PII_AGENT_TOOLS names the roster tool (the execute route refuses it for MEMBER)", () => {
    expect(ROSTER_PII_AGENT_TOOLS.has("list_rsvps")).toBe(true);
  });
});
