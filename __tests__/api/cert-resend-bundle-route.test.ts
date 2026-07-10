/**
 * POST /api/events/[eventId]/certificates/issued/resend-bundle — the
 * "Resend all as ONE email" action. Asserts: happy path (one bundle send,
 * N attachments, resend counters bumped on exactly the sent certs),
 * unloadable-PDF skip, no-sendable-certs 409, send-fail 502 (no counter
 * bump), validation 400, auth guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockAuth,
  mockBundleSend,
  mockBuildWhere,
  mockLoadPdf,
  mockResolveEmail,
  mockLoadRecipient,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    issuedCertificate: { findMany: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  mockBundleSend: vi.fn(),
  mockBuildWhere: vi.fn(),
  mockLoadPdf: vi.fn(),
  mockResolveEmail: vi.fn(),
  mockLoadRecipient: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } }) =>
    ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"].includes(session.user?.role ?? "")
      ? new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
      : null,
}));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/certificates/bundle", () => ({
  buildPersonCertificateWhere: (...a: unknown[]) => mockBuildWhere(...a),
  sendCertificateBundleEmail: (args: unknown) => mockBundleSend(args),
  resolveRecipientEmail: (...a: unknown[]) => mockResolveEmail(...a),
}));
vi.mock("@/lib/certificates/deliver", () => ({
  // Template-aware cover resolution is unit-tested in certificates-deliver;
  // here the route just needs A cover to hand to the (mocked) sender.
  resolveResendBundleCover: vi.fn().mockResolvedValue({
    subject: "Your certificates",
    body: "<p>Multi {{certificateList}}</p>",
  }),
}));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: (url: string) => mockLoadPdf(url),
}));
vi.mock("@/lib/certificates/cert-context", () => ({
  loadRecipient: (...a: unknown[]) => mockLoadRecipient(...a),
}));

import { POST } from "@/app/api/events/[eventId]/certificates/issued/resend-bundle/route";

const PARAMS = { params: Promise.resolve({ eventId: "evt-1" }) };
const ADMIN = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };

function post(body: unknown) {
  return POST(
    new Request("http://x/api/events/evt-1/certificates/issued/resend-bundle", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    PARAMS,
  );
}

const CERTS = [
  { id: "c1", serial: "ATT-1", type: "ATTENDANCE", pdfUrl: "/uploads/certificates/e/1.pdf", certificateTemplate: { name: "Attendance" } },
  { id: "c2", serial: "APP-2", type: "APPRECIATION", pdfUrl: "/uploads/certificates/e/2.pdf", certificateTemplate: { name: "Speaker" } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ADMIN);
  mockDb.event.findFirst.mockResolvedValue({ organizationId: "org-1" });
  mockDb.issuedCertificate.findMany.mockResolvedValue(CERTS);
  mockDb.issuedCertificate.updateMany.mockResolvedValue({ count: 2 });
  mockDb.auditLog.create.mockResolvedValue({});
  mockBuildWhere.mockResolvedValue({
    where: { eventId: "evt-1" },
    linkedRegistrationId: "reg-1",
    linkedSpeakerId: "spk-1",
  });
  mockLoadPdf.mockResolvedValue(Buffer.from("%PDF"));
  mockResolveEmail.mockResolvedValue("jane@x.com");
  mockLoadRecipient.mockResolvedValue({ fullName: "Dr. Jane Doe" });
  mockBundleSend.mockResolvedValue({ success: true, messageId: "m1" });
});

describe("POST /certificates/issued/resend-bundle", () => {
  it("sends the person's full cert set in ONE email and bumps only the sent certs", async () => {
    const res = await post({ registrationId: "reg-1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ sentCount: 2, serials: ["ATT-1", "APP-2"], recipientEmail: "jane@x.com" });

    expect(mockBundleSend).toHaveBeenCalledTimes(1);
    const sent = mockBundleSend.mock.calls[0][0];
    expect(sent.certs).toHaveLength(2);
    expect(sent.registrationId).toBe("reg-1");
    expect(sent.speakerId).toBe("spk-1");
    // Multi default cover email.
    expect(sent.emailSubjectTemplate).toContain("Your certificates");

    expect(mockDb.issuedCertificate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["c1", "c2"] } },
        data: expect.objectContaining({ resendCount: { increment: 1 } }),
      }),
    );
  });

  it("skips an unloadable PDF but sends the rest", async () => {
    mockLoadPdf.mockImplementation((url: string) =>
      url.includes("/1.pdf") ? Promise.reject(new Error("ENOENT")) : Promise.resolve(Buffer.from("%PDF")),
    );
    const res = await post({ registrationId: "reg-1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sentCount).toBe(1);
    expect(json.serials).toEqual(["APP-2"]);
    expect(mockDb.issuedCertificate.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["c2"] } });
  });

  it("409s when the person has no sendable certs", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([]);
    const res = await post({ speakerId: "spk-1" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_SENDABLE_CERTS");
    expect(mockBundleSend).not.toHaveBeenCalled();
  });

  it("502s on send failure without bumping counters", async () => {
    mockBundleSend.mockResolvedValue({ success: false, error: "SES down" });
    const res = await post({ registrationId: "reg-1" });
    expect(res.status).toBe(502);
    expect(mockDb.issuedCertificate.updateMany).not.toHaveBeenCalled();
  });

  it("400s when neither or both facet ids are supplied", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ registrationId: "r", speakerId: "s" })).status).toBe(400);
  });

  it("401s unauthenticated and 404s cross-tenant", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post({ registrationId: "r" })).status).toBe(401);
    mockAuth.mockResolvedValue(ADMIN);
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await post({ registrationId: "r" })).status).toBe(404);
  });
});
