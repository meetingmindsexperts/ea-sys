/**
 * Survey Invitation to ONE registration from the detail sheet (Sep 17, 2026).
 *
 * The route hands the send to executeBulkEmail with this registration as the
 * only recipient, so the personal link, the template repair and the "event
 * has a survey" precheck are the Communications send's own code. These tests
 * pin the hand-off and the refusals the route makes before it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, executeBulkEmailSpy, MockBulkEmailError } = vi.hoisted(() => {
  class MockBulkEmailError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 400, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          firstName: "Rana",
          lastName: "Haddad",
          email: "rana@org.com",
          emailSignature: "<p>Rana</p>",
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    mockAuth: vi.fn(),
    executeBulkEmailSpy: vi.fn(),
    MockBulkEmailError,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true }),
}));
vi.mock("@/lib/bulk-email", () => ({
  executeBulkEmail: executeBulkEmailSpy,
  BulkEmailError: MockBulkEmailError,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn(),
  getDefaultTemplate: vi.fn(),
  renderAndWrap: vi.fn(),
  renderMessageValue: vi.fn(),
  brandingFrom: vi.fn(),
  brandingCc: vi.fn(),
  sendRegistrationConfirmation: vi.fn(),
}));
vi.mock("@/lib/email-barcode", () => ({ buildEntryBarcode: vi.fn(), templateUsesEntryBarcode: () => false }));
vi.mock("@/lib/email-change", () => ({ normalizeEmail: vi.fn(), repointOrgContactEmail: vi.fn() }));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const send = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params });

function registration(extra: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    eventId: "ev1",
    status: "CONFIRMED",
    surveyCompletedAt: null,
    groupId: null,
    attendee: { firstName: "Sara", lastName: "Al Harthy", email: "sara@hospital.com", additionalEmail: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "oopvf", name: "OOPVF", organizationId: "org1" });
  mockDb.registration.findFirst.mockResolvedValue(registration());
  executeBulkEmailSpy.mockResolvedValue({ total: 1, successCount: 1, failureCount: 0, errors: [] });
});

describe("Survey Invitation to one registration", () => {
  it("sends through the bulk send with this registration as the only recipient", async () => {
    const res = await send({ type: "survey-invitation", surveyExpiryDays: 30 });

    expect(res.status).toBe(200);
    expect(executeBulkEmailSpy).toHaveBeenCalledTimes(1);
    expect(executeBulkEmailSpy.mock.calls[0][0]).toMatchObject({
      eventId: "ev1",
      recipientType: "registrations",
      recipientIds: ["reg1"],
      emailType: "survey-invitation",
      filters: { surveyExpiryDays: 30 },
      organizerName: "Rana Haddad",
      organizerSignature: "<p>Rana</p>",
      triggeredByUserId: "admin1",
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      emailType: "survey-invitation",
      surveyExpiryDays: 30,
    });
  });

  it("leaves the expiry to the default when none is sent", async () => {
    await send({ type: "survey-invitation" });
    expect(executeBulkEmailSpy.mock.calls[0][0].filters).toBeUndefined();
  });

  it("refuses a cancelled registration without sending", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ status: "CANCELLED" }));
    const res = await send({ type: "survey-invitation" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("REGISTRATION_CANCELLED");
    expect(executeBulkEmailSpy).not.toHaveBeenCalled();
  });

  it("refuses someone who already completed the survey", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ surveyCompletedAt: new Date() }));
    const res = await send({ type: "survey-invitation" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SURVEY_ALREADY_COMPLETED");
    expect(executeBulkEmailSpy).not.toHaveBeenCalled();
  });

  it("passes the bulk send's refusal through, e.g. no survey built", async () => {
    executeBulkEmailSpy.mockRejectedValue(
      new MockBulkEmailError("No survey is configured for this event. Build the survey at Survey first.", 400),
    );
    const res = await send({ type: "survey-invitation" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No survey is configured");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports a failed delivery instead of success", async () => {
    executeBulkEmailSpy.mockResolvedValue({
      total: 1,
      successCount: 0,
      failureCount: 1,
      errors: [{ email: "sara@hospital.com", error: "SES rejected" }],
    });
    const res = await send({ type: "survey-invitation" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("SES rejected");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an expiry outside 1 to 365 days", async () => {
    const res = await send({ type: "survey-invitation", surveyExpiryDays: 400 });
    expect(res.status).toBe(400);
    expect(executeBulkEmailSpy).not.toHaveBeenCalled();
  });
});
