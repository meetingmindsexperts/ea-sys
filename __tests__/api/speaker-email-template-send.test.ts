/**
 * POST /api/events/[eventId]/speakers/[speakerId]/email — the `type:
 * "template"` branch (July 31, 2026): single-send parity with the bulk
 * dialog's "Your saved template" option. Pins: templateSlug required, the
 * saved template resolves via getEventTemplate (active-only — a deactivated
 * custom template hard-fails 400, never silently falls back to a different
 * email), the ACTUAL slug lands in the EmailLog logContext, and the legacy
 * types keep their slugMap resolution.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, sendEmailSpy, getEventTemplateSpy, getDefaultTemplateSpy } = vi.hoisted(
  () => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      speaker: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    mockAuth: vi.fn(),
    sendEmailSpy: vi.fn(),
    getEventTemplateSpy: vi.fn(),
    getDefaultTemplateSpy: vi.fn(),
  }),
);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number; headers?: Record<string, string> }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: (k: string) => i?.headers?.[k] ?? null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) => cb(mockDb),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, cb: () => unknown) => cb(),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0, remaining: 1 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: getEventTemplateSpy,
  getDefaultTemplate: getDefaultTemplateSpy,
  renderAndWrap: vi.fn().mockReturnValue({ subject: "Rendered Subject", html: "<p>h</p>", text: "t" }),
  renderMessageValue: vi.fn((v: string) => v),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/email-change", () => ({
  normalizeEmail: (e: string) => e.toLowerCase(),
  repointOrgContactEmail: vi.fn(),
}));
vi.mock("@/lib/speaker-agreement", () => ({
  buildAgreementBlock: vi.fn().mockReturnValue({ html: "", text: "" }),
  buildSpeakerEmailContext: vi.fn().mockResolvedValue(null),
  generateSpeakerAgreementDocx: vi.fn(),
  generateSpeakerAgreementPdf: vi.fn(),
  mintSpeakerAgreementLink: vi.fn().mockResolvedValue("https://x/agree"),
  pickAgreementAttachmentMode: vi.fn().mockReturnValue(null),
  templateUsesAgreementBlock: vi.fn().mockReturnValue(false),
  templateUsesAgreementAttachment: vi.fn().mockReturnValue(false),
  SPEAKER_AGREEMENT_DOCX_MIME: "application/docx",
  SPEAKER_AGREEMENT_PDF_MIME: "application/pdf",
}));
vi.mock("@/lib/email-attachments", () => ({
  validateManualAttachments: vi.fn().mockReturnValue({ ok: true, attachments: [] }),
}));
vi.mock("@/lib/email-attachment-limits", () => ({ MAX_MANUAL_ATTACHMENTS: 3 }));

import { POST } from "@/app/api/events/[eventId]/speakers/[speakerId]/email/route";

const routeParams = { params: Promise.resolve({ eventId: "ev1", speakerId: "sp1" }) };

function makeReq(body: Record<string, unknown>) {
  return new Request("http://t/api/events/ev1/speakers/sp1/email", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "ADMIN", organizationId: "org1", email: "admin@x.com" },
  });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    name: "Ev",
    slug: "ev-slug",
    venue: "Hall",
    startDate: new Date("2026-09-01"),
    speakerAgreementTemplate: null,
    speakerAgreementHtml: null,
  });
  mockDb.speaker.findFirst.mockResolvedValue({
    id: "sp1",
    email: "spk@x.com",
    firstName: "Jane",
    lastName: "Doe",
    title: "DR",
    additionalEmail: null,
    agreementAcceptedAt: null,
    sessions: [],
  });
  mockDb.user.findUnique.mockResolvedValue({
    firstName: "Org",
    lastName: "Anizer",
    email: "org@x.com",
    emailSignature: null,
  });
  sendEmailSpy.mockResolvedValue({ success: true, messageId: "m1" });
  getEventTemplateSpy.mockResolvedValue(null);
  getDefaultTemplateSpy.mockReturnValue({ subject: "Def", htmlContent: "<p>d</p>", textContent: "d" });
});

describe("speaker single-send — saved template type", () => {
  it("400s TEMPLATE_SLUG_REQUIRED when type=template has no slug", async () => {
    const res = await POST(makeReq({ type: "template" }), routeParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TEMPLATE_SLUG_REQUIRED");
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("sends the SAVED template: resolves by slug, tags speaker_template, logs the ACTUAL slug", async () => {
    getEventTemplateSpy.mockResolvedValue({
      subject: "Saved Subject",
      htmlContent: "<p>saved</p>",
      textContent: "saved",
      branding: { eventName: "Ev" },
    });
    const res = await POST(
      makeReq({ type: "template", templateSlug: "my-followup" }),
      routeParams,
    );
    expect(res.status).toBe(200);
    expect(getEventTemplateSpy).toHaveBeenCalledWith("ev1", "my-followup");
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.emailType).toBe("speaker_template");
    // Email History must show WHICH saved template went out.
    expect(call.logContext.templateSlug).toBe("my-followup");
  });

  it("hard-400s TEMPLATE_NOT_AVAILABLE when the custom template is deactivated/missing — never a silent fallback", async () => {
    getEventTemplateSpy.mockResolvedValue(null);
    getDefaultTemplateSpy.mockReturnValue(null); // custom slug has no system default
    const res = await POST(
      makeReq({ type: "template", templateSlug: "my-followup" }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TEMPLATE_NOT_AVAILABLE");
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("legacy types keep slugMap resolution (invitation → speaker-invitation)", async () => {
    const res = await POST(makeReq({ type: "invitation" }), routeParams);
    expect(res.status).toBe(200);
    expect(getEventTemplateSpy).toHaveBeenCalledWith("ev1", "speaker-invitation");
    expect(sendEmailSpy.mock.calls[0][0].logContext.templateSlug).toBe("speaker-invitation");
  });
});
