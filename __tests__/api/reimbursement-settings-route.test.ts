/**
 * GET/PUT /api/events/[eventId]/reimbursements/settings — which claim types
 * the event offers (Sep 8, 2026).
 *
 *   - the reimbursement boundary through the REAL denyReviewer: MEMBER /
 *     ONSITE / WEBINARS / REVIEWER / SUBMITTER refused; ADMIN + ORGANIZER pass
 *   - GET reads through readEventClaimItems: nothing configured = all five
 *   - PUT stores the canonical list under settings.reimbursement.claimItems
 *     through the atomic merge helper, touching no sibling key, and audits
 *     before → after; an empty list is refused
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit, mockUpdateEventSettings } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockUpdateEventSettings: vi.fn(),
}));

vi.mock("next/server", () => {
  class MockNextResponse {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return { status: init?.status ?? 200, json: async () => body };
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "10.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(() => ({ id: "evt1" })),
}));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));

import { GET, PUT } from "@/app/api/events/[eventId]/reimbursements/settings/route";

const params = () => ({ params: Promise.resolve({ eventId: "evt1" }) }) as never;
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = (body?: unknown) => ({ json: async () => body, headers: new Map() }) as never;
const ALL = ["SPEAKER_FEE", "FLIGHT", "HOTEL", "TRANSPORT", "OTHER"];

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", settings: {} });
  mockUpdateEventSettings.mockResolvedValue({});
});

describe("access: the reimbursement boundary", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(401);
    expect((await PUT(req({ claimItems: ["FLIGHT"] }), params())).status).toBe(401);
  });

  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT"])(
    "%s is refused on both verbs and nothing is written",
    async (role) => {
      mockAuth.mockResolvedValue(session(role));
      expect((await GET(req(), params())).status).toBe(403);
      expect((await PUT(req({ claimItems: ["FLIGHT"] }), params())).status).toBe(403);
      expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN"])("%s may read and write", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), params())).status).toBe(200);
    expect((await PUT(req({ claimItems: ["FLIGHT"] }), params())).status).toBe(200);
  });

  it("404 when the event is not reachable by the caller", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
    expect((await PUT(req({ claimItems: ["FLIGHT"] }), params())).status).toBe(404);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("429 when the per-user bucket is spent", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await PUT(req({ claimItems: ["FLIGHT"] }), params())).status).toBe(429);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("nothing configured reads as all five", async () => {
    expect(await (await GET(req(), params())).json()).toEqual({ claimItems: ALL });
  });

  it("a configured list reads back in canonical order", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt1",
      organizationId: "org1",
      settings: { reimbursement: { claimItems: ["HOTEL", "FLIGHT"] } },
    });
    expect(await (await GET(req(), params())).json()).toEqual({ claimItems: ["FLIGHT", "HOTEL"] });
  });
});

describe("PUT", () => {
  it("refuses an empty list and an unknown key (400), writing nothing", async () => {
    expect((await PUT(req({ claimItems: [] }), params())).status).toBe(400);
    expect((await PUT(req({ claimItems: ["BOGUS"] }), params())).status).toBe(400);
    expect((await PUT(req(null), params())).status).toBe(400);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("saves the canonical list under settings.reimbursement.claimItems and keeps sibling keys", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt1",
      organizationId: "org1",
      settings: { reimbursement: { claimItems: ["FLIGHT"] } },
    });
    const res = await PUT(req({ claimItems: ["OTHER", "HOTEL", "HOTEL"] }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimItems: ["HOTEL", "OTHER"] });

    expect(mockUpdateEventSettings).toHaveBeenCalledTimes(1);
    const [eventId, patch] = mockUpdateEventSettings.mock.calls[0];
    expect(eventId).toBe("evt1");
    // The function-form patch merges into the locked current blob.
    const next = (patch as (cur: Record<string, unknown>) => Record<string, unknown>)({
      webinar: { sessionId: "s1" },
      reimbursement: { claimItems: ["FLIGHT"], somethingElse: true },
    });
    expect(next).toEqual({
      webinar: { sessionId: "s1" },
      reimbursement: { claimItems: ["HOTEL", "OTHER"], somethingElse: true },
    });

    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("REIMBURSEMENT_SETTINGS_SET");
    expect(audit.entityType).toBe("Event");
    expect(audit.entityId).toBe("evt1");
    expect(audit.changes.before).toEqual({ claimItems: ["FLIGHT"] });
    expect(audit.changes.after).toEqual({ claimItems: ["HOTEL", "OTHER"] });
  });
});
