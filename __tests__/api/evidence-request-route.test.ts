/**
 * POST /api/events/[eventId]/registrations/evidence-request (Nov 4, 2026):
 * a bulk send, so it follows the bulk email key, the grant's event scope and
 * its own rate limit, before anything reaches the service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authSpy, gateSpy, eventFindFirst, sendSpy, rateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  gateSpy: vi.fn(),
  eventFindFirst: vi.fn(),
  sendSpy: vi.fn(),
  rateSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: gateSpy }));
vi.mock("@/lib/db", () => ({
  db: { event: { findFirst: eventFindFirst }, user: { findUnique: vi.fn().mockResolvedValue({ emailSignature: "" }) } },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: rateSpy }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, cb: () => unknown) => cb() }));
vi.mock("@/services/evidence-request-service", () => ({ sendEvidenceRequests: sendSpy }));

import { POST } from "@/app/api/events/[eventId]/registrations/evidence-request/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const VALID = { registrationIds: ["r1"], expiryDays: 14 };

beforeEach(() => {
  vi.clearAllMocks();
  authSpy.mockResolvedValue({ user: { id: "u1", organizationId: "org1", firstName: "A", lastName: "B" } });
  gateSpy.mockReturnValue({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } });
  eventFindFirst.mockResolvedValue({ id: "ev1" });
  rateSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  sendSpy.mockResolvedValue({ ok: true, sent: 1, skipped: [], errors: [] });
});

describe("evidence-request route", () => {
  it("401s without a session", async () => {
    authSpy.mockResolvedValue(null);
    expect((await POST(req(VALID), params)).status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("asks the bulk email key, and stops when it is not held", async () => {
    gateSpy.mockReturnValue({ ok: false, response: { status: 403, json: async () => ({}) } });
    expect((await POST(req(VALID), params)).status).toBe(403);
    expect(gateSpy).toHaveBeenCalledWith(expect.anything(), "communications.send", expect.objectContaining({ eventId: "ev1" }));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("404s an event outside the grant's scope", async () => {
    eventFindFirst.mockResolvedValue(null);
    expect((await POST(req(VALID), params)).status).toBe(404);
    expect(eventFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ev1", organizationId: "org1" } }));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a lifetime outside 1 to 365 days, and an empty selection", async () => {
    expect((await POST(req({ ...VALID, expiryDays: 0 }), params)).status).toBe(400);
    expect((await POST(req({ ...VALID, registrationIds: [] }), params)).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("429s past the hourly limit", async () => {
    rateSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await POST(req(VALID), params);
    expect(res.status).toBe(429);
    expect((await res.json()).retryAfterSeconds).toBe(120);
  });

  it("hands the selection to the service and reports skips", async () => {
    sendSpy.mockResolvedValue({ ok: true, sent: 1, skipped: [{ registrationId: "r2", reason: "NOTHING_MISSING" }], errors: [] });
    const res = await POST(req({ registrationIds: ["r1", "r2"], expiryDays: 30 }), params);
    expect(await res.json()).toEqual({
      sent: 1,
      skipped: 1,
      skippedDetails: [{ registrationId: "r2", reason: "NOTHING_MISSING" }],
      errors: [],
    });
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ registrationIds: ["r1", "r2"], expiryDays: 30, organizationId: "org1" }));
  });
});
