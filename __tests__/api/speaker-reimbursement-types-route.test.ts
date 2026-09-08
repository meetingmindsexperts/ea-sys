/**
 * GET/PATCH /api/events/[eventId]/speakers/[speakerId]/reimbursement-types —
 * the per-speaker override of which claim types may be claimed (Sep 8, 2026).
 *
 *   - the reimbursement boundary through the REAL denyReviewer (honorarium
 *     route parity): MEMBER / ONSITE / WEBINARS / REVIEWER / SUBMITTER refused
 *   - GET returns the override (null = inherit), the event default and the
 *     effective list the form will offer
 *   - PATCH binds the write to { id, eventId }; null goes back to inheriting
 *     (stored as JSON null); the audit row carries before → after
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockAuth, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
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

import { GET, PATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/reimbursement-types/route";

const params = () =>
  ({ params: Promise.resolve({ eventId: "evt1", speakerId: "spk1" }) }) as never;
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = (body?: unknown) => ({ json: async () => body, headers: new Map() }) as never;
const ALL = ["SPEAKER_FEE", "FLIGHT", "HOTEL", "TRANSPORT", "OTHER"];

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt1",
    organizationId: "org1",
    settings: { reimbursement: { claimItems: ["FLIGHT", "HOTEL"] } },
  });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", reimbursementClaimItems: null });
  mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
});

describe("access: the reimbursement boundary", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(401);
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(401);
  });

  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT"])(
    "%s is refused on both verbs and nothing is written",
    async (role) => {
      mockAuth.mockResolvedValue(session(role));
      expect((await GET(req(), params())).status).toBe(403);
      expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(403);
      expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN"])("%s may read and write", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), params())).status).toBe(200);
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(200);
  });

  it("404 when the event or the speaker is not reachable, and a write that misses is a 404 too", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(404);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", settings: {} });
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(404);
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", reimbursementClaimItems: null });
    mockDb.speaker.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(404);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("429 when the per-user bucket is spent", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await PATCH(req({ claimItems: ["OTHER"] }), params())).status).toBe(429);
    expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("inheriting: claimItems null, the event's list as the effective set", async () => {
    expect(await (await GET(req(), params())).json()).toEqual({
      claimItems: null,
      eventClaimItems: ["FLIGHT", "HOTEL"],
      effective: ["FLIGHT", "HOTEL"],
    });
  });

  it("an override wins over the event default; an event with nothing set defaults to all five", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", reimbursementClaimItems: ["OTHER", "SPEAKER_FEE"] });
    expect(await (await GET(req(), params())).json()).toEqual({
      claimItems: ["SPEAKER_FEE", "OTHER"],
      eventClaimItems: ["FLIGHT", "HOTEL"],
      effective: ["SPEAKER_FEE", "OTHER"],
    });
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", settings: null });
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", reimbursementClaimItems: null });
    expect((await (await GET(req(), params())).json()).effective).toEqual(ALL);
  });
});

describe("PATCH", () => {
  it("refuses an empty list, an unknown key and a missing body (400), writing nothing", async () => {
    expect((await PATCH(req({ claimItems: [] }), params())).status).toBe(400);
    expect((await PATCH(req({ claimItems: ["BOGUS"] }), params())).status).toBe(400);
    expect((await PATCH(req(null), params())).status).toBe(400);
    expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
  });

  it("sets the override with the write bound to { id, eventId } and audits before → after", async () => {
    const res = await PATCH(req({ claimItems: ["HOTEL", "SPEAKER_FEE"] }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimItems: ["SPEAKER_FEE", "HOTEL"],
      eventClaimItems: ["FLIGHT", "HOTEL"],
      effective: ["SPEAKER_FEE", "HOTEL"],
    });
    const call = mockDb.speaker.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "spk1", eventId: "evt1" });
    expect(call.data).toEqual({ reimbursementClaimItems: ["SPEAKER_FEE", "HOTEL"] });

    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("REIMBURSEMENT_TYPES_SET");
    expect(audit.entityType).toBe("Speaker");
    expect(audit.entityId).toBe("spk1");
    expect(audit.changes.before).toBeNull();
    expect(audit.changes.after).toEqual(["SPEAKER_FEE", "HOTEL"]);
  });

  it("null goes back to inheriting: stored as JSON null, effective = the event default", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", reimbursementClaimItems: ["OTHER"] });
    const res = await PATCH(req({ claimItems: null }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimItems: null,
      eventClaimItems: ["FLIGHT", "HOTEL"],
      effective: ["FLIGHT", "HOTEL"],
    });
    expect(mockDb.speaker.updateMany.mock.calls[0][0].data).toEqual({ reimbursementClaimItems: Prisma.JsonNull });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.changes.before).toEqual(["OTHER"]);
    expect(audit.changes.after).toBeNull();
  });
});
