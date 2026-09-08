/**
 * PATCH /api/events/[eventId]/travel-grants/[grantId] — the organizer sets a
 * grant's status from the console (Sep 8, 2026), the speaker-agreement
 * accept/revoke pattern.
 *
 *   - the travel-grant boundary through the REAL denyReviewer: MEMBER / ONSITE
 *     / WEBINARS / REVIEWER / SUBMITTER refused; ADMIN + ORGANIZER pass
 *   - the write binds { id, eventId }; a same-status call is a no-op
 *   - reopen clears the author's answer; an organizer-set CONSENTED snapshots
 *     the terms but carries NO signed name; every transition stamps decidedBy
 *     and audits before → after
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    travelGrant: { findFirst: vi.fn(), updateMany: vi.fn() },
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

import { PATCH } from "@/app/api/events/[eventId]/travel-grants/[grantId]/route";

const params = () => ({ params: Promise.resolve({ eventId: "evt1", grantId: "tg1" }) }) as never;
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = (body?: unknown) => ({ json: async () => body, headers: new Map() }) as never;
const grant = (over: Record<string, unknown> = {}) => ({
  id: "tg1",
  status: "PENDING",
  signedName: null,
  decidedBy: null,
  speaker: { id: "spk1", firstName: "Ana", lastName: "Silva", organization: "Hospital X", country: "Portugal" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", travelGrantTermsHtml: "<p>Terms.</p>" });
  mockDb.travelGrant.findFirst.mockResolvedValue(grant());
  mockDb.travelGrant.updateMany.mockResolvedValue({ count: 1 });
});

describe("access: the travel-grant boundary", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(401);
  });

  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT"])(
    "%s is refused and nothing is written",
    async (role) => {
      mockAuth.mockResolvedValue(session(role));
      expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(403);
      expect(mockDb.travelGrant.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN"])("%s may set the status", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(200);
  });

  it("404 when the event or the grant is out of reach, and a missed write is a 404 with no audit", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(404);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", travelGrantTermsHtml: null });
    mockDb.travelGrant.findFirst.mockResolvedValue(null);
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(404);
    mockDb.travelGrant.findFirst.mockResolvedValue(grant());
    mockDb.travelGrant.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(404);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("400 on an unknown status or a missing body; 429 when the bucket is spent", async () => {
    expect((await PATCH(req({ status: "APPROVED" }), params())).status).toBe(400);
    expect((await PATCH(req(null), params())).status).toBe(400);
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await PATCH(req({ status: "DECLINED" }), params())).status).toBe(429);
    expect(mockDb.travelGrant.updateMany).not.toHaveBeenCalled();
  });
});

describe("transitions", () => {
  it("records a decline on the author's behalf, bound to { id, eventId }, stamped and audited", async () => {
    const res = await PATCH(req({ status: "DECLINED" }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true, status: "DECLINED", decidedBy: "ORGANIZER:u1" });
    const call = mockDb.travelGrant.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "tg1", eventId: "evt1" });
    expect(call.data).toMatchObject({ status: "DECLINED", decidedBy: "ORGANIZER:u1", signedName: null, submittedIp: "10.0.0.1" });
    expect(call.data.submittedAt).toBeInstanceOf(Date);
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("TRAVEL_GRANT_STATUS_SET");
    expect(audit.entityId).toBe("tg1");
    expect(audit.changes.before).toEqual({ status: "PENDING", signedName: null, decidedBy: null });
    expect(audit.changes.after).toEqual({ status: "DECLINED", decidedBy: "ORGANIZER:u1" });
    expect(audit.changes.actor).toBe("ORGANIZER");
  });

  it("records an application on the author's behalf with the terms snapshot and NO signed name", async () => {
    const res = await PATCH(req({ status: "CONSENTED" }), params());
    expect(res.status).toBe(200);
    const data = mockDb.travelGrant.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "CONSENTED",
      signedName: null,
      countryAtConsent: "Portugal",
      fullName: "Ana Silva",
      institution: "Hospital X",
      termsSnapshot: "<p>Terms.</p>",
      decidedBy: "ORGANIZER:u1",
    });
  });

  it("falls back to the built-in terms when the organizer wrote none", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1", travelGrantTermsHtml: "  " });
    await PATCH(req({ status: "CONSENTED" }), params());
    expect(mockDb.travelGrant.updateMany.mock.calls[0][0].data.termsSnapshot).toContain("not a resident");
  });

  it("reopening a declined grant clears the author's answer so the same link accepts a new one", async () => {
    mockDb.travelGrant.findFirst.mockResolvedValue(grant({ status: "DECLINED", signedName: null }));
    const res = await PATCH(req({ status: "PENDING" }), params());
    expect(res.status).toBe(200);
    const data = mockDb.travelGrant.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({
      status: "PENDING",
      signedName: null,
      submittedAt: null,
      submittedIp: null,
      countryAtConsent: null,
      fullName: null,
      institution: null,
      termsSnapshot: null,
      decidedBy: "ORGANIZER:u1",
    });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.changes.before.status).toBe("DECLINED");
    expect(audit.changes.after.status).toBe("PENDING");
  });

  it("the same status again is a no-op: nothing written, nothing audited", async () => {
    mockDb.travelGrant.findFirst.mockResolvedValue(grant({ status: "DECLINED", decidedBy: "ORGANIZER:u9" }));
    const res = await PATCH(req({ status: "DECLINED" }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: false, status: "DECLINED", decidedBy: "ORGANIZER:u9" });
    expect(mockDb.travelGrant.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});
