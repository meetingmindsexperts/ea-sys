/**
 * POST .../import/registrations/send-completion-emails (Send Registration
 * Form): the rate, sponsor and link lifetime reach the service; the event is
 * resolved through the grant's own scope first; refusals map to HTTP.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, sendMock } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() }, user: { findUnique: vi.fn() } },
  sendMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org-1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev-1", organizationId: "org-1" } }),
}));
vi.mock("@/services/registration-form-service", () => ({ sendRegistrationForms: sendMock }));

import { POST } from "@/app/api/events/[eventId]/import/registrations/send-completion-emails/route";

const params = { params: Promise.resolve({ eventId: "ev-1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u-1", role: "ADMIN", organizationId: "org-1", firstName: "Kay", lastName: "P" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
  mockDb.user.findUnique.mockResolvedValue({ emailSignature: "<p>sig</p>" });
  sendMock.mockResolvedValue({ ok: true, sent: 2, skipped: [], errors: [], rateName: "Early Bird", rateClosesAt: null });
});

describe("Send Registration Form route", () => {
  it("passes the rate, sponsor and lifetime to the service", async () => {
    const res = await POST(req({ registrationIds: ["r1", "r2"], rate: "early-bird", sponsorId: "sp-1", expiryDays: 30 }), params);
    expect(res.status).toBe(200);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      eventId: "ev-1", registrationIds: ["r1", "r2"], rate: { kind: "rate", slug: "early-bird" },
      sponsorId: "sp-1", expiryDays: 30, organizerName: "Kay P", organizerSignature: "<p>sig</p>", source: "rest",
    });
  });

  it("complimentary, and the lifetime defaults to 7 days", async () => {
    await POST(req({ registrationIds: ["r1"], rate: "_complimentary" }), params);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ rate: { kind: "complimentary" }, expiryDays: 7 });
  });

  it("refuses a missing rate and a lifetime out of bounds, without sending", async () => {
    expect((await POST(req({ registrationIds: ["r1"] }), params)).status).toBe(400);
    expect((await POST(req({ registrationIds: ["r1"], rate: "early-bird", expiryDays: 400 }), params)).status).toBe(400);
    expect((await POST(req({ registrationIds: ["r1"], rate: "early-bird", expiryDays: 2.5 }), params)).status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("an event outside the grant's scope is a 404 before the service runs", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await POST(req({ registrationIds: ["r1"], rate: "early-bird" }), params)).status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("maps refusals, and reports skips with their reasons", async () => {
    sendMock.mockResolvedValueOnce({ ok: false, code: "RATE_NOT_FOUND", message: "no" });
    expect((await POST(req({ registrationIds: ["r1"], rate: "onsite" }), params)).status).toBe(400);
    sendMock.mockResolvedValueOnce({ ok: true, sent: 1, skipped: [{ registrationId: "r2", email: "b@x", reason: "HAS_ACCOUNT" }], errors: [], rateName: "Early Bird", rateClosesAt: null });
    const body = await (await POST(req({ registrationIds: ["r1", "r2"], rate: "early-bird" }), params)).json();
    expect(body).toMatchObject({ sent: 1, skipped: 1, skippedDetails: [{ reason: "HAS_ACCOUNT" }] });
  });
});
