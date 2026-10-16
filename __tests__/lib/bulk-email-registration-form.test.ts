/**
 * executeBulkEmail: the "Registration form" type (Oct 16, 2026,
 * docs/REGISTRATION_FORM_LINKS_PLAN.md). The checks and the rate stamp run
 * through registration-form-service before any batch; skipped people are
 * counted with their reasons and never emailed; each person sent gets their
 * own link at the chosen rate and lifetime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockSendEmail,
  mockRenderAndWrap,
  mockGetDefaultTemplate,
  mockGetEventTemplate,
  mockWarn,
  prepareMock,
  mintMock,
} = vi.hoisted(() => ({
  prepareMock: vi.fn(),
  mintMock: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },

    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockSendEmail: vi.fn(),
  mockRenderAndWrap: vi.fn(),
  mockGetDefaultTemplate: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: mockWarn, debug: vi.fn() },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    loadActiveEventTemplateRow: vi.fn(),
    getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
    getDefaultTemplate: (...args: unknown[]) => mockGetDefaultTemplate(...args),
    renderMessageValue: vi.fn((m: string) => m),
    renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
    brandingFrom: vi.fn(),
    brandingCc: vi.fn(),
  };
});
vi.mock("@/lib/speaker-agreement", () => ({
  buildSpeakerEmailContext: vi.fn(),
  generateSpeakerAgreementDocx: vi.fn(),
  generateSpeakerAgreementPdf: vi.fn(),
  pickAgreementAttachmentMode: vi.fn(),
  SPEAKER_AGREEMENT_DOCX_MIME: "application/vnd.docx",
  SPEAKER_AGREEMENT_PDF_MIME: "application/pdf",
}));
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

vi.mock("@/services/registration-form-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/registration-form-service")>();
  return { ...actual, prepareRegistrationForms: prepareMock, mintRegistrationFormLink: mintMock };
});

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  organizationId: "org-1",
  slug: "oopvf",
  name: "Oman Oncology Pharmacy Value Forum 2026",
  startDate: new Date("2026-09-12"),
  timezone: "Asia/Muscat",
  venue: "Muscat",
  city: null,
  country: null,
  address: null,
  settings: {},
  emailFromAddress: null,
  emailFromName: null,
  emailCcAddresses: null,
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  speakerAgreementTemplate: null,
  speakerAgreementHtml: null,
  travelGrantMessageHtml: null,
  surveyConfig: null,
  taxRate: null,
  taxLabel: null,
};

const reg = (id: string, email: string, firstName: string) => ({
  id,
  serialId: 1,
  qrCode: null,
  attendanceMode: "IN_PERSON",
  originalPrice: null,
  discountAmount: null,
  pricingTier: null,
  ticketType: { name: "Delegate", price: 0, currency: "USD" },
  attendee: { email, additionalEmail: null, firstName, lastName: "Doe", title: "DR" },
});

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "registration-form" as const,
  organizerName: "Org Anizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

const TEMPLATE = { subject: "Complete", htmlContent: "<a href='{{registrationFormLink}}'>go</a> {{rateName}} {{linkExpiresIn}} {{linkExpiresOn}}", textContent: "{{registrationFormLink}}", branding: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([
    reg("reg-jane", "jane@x.com", "Jane"),
    reg("reg-bob", "bob@x.com", "Bob"),
  ]);
  mockGetEventTemplate.mockResolvedValue(TEMPLATE);
  mockGetDefaultTemplate.mockReturnValue(TEMPLATE);
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
  prepareMock.mockResolvedValue({
    ok: true,
    ready: [{ registrationId: "reg-jane" }],
    skipped: [{ registrationId: "reg-bob", email: "bob@x.com", reason: "HAS_ACCOUNT" }],
    rateName: "Early Bird",
    rateClosesAt: null,
    event: { id: "evt-1", slug: "oopvf", timezone: "Asia/Muscat" },
  });
  mintMock.mockImplementation(async ({ registrationId }: { registrationId: string }) => ({
    url: `https://x.test/e/oopvf/complete-registration?token=${registrationId}`,
    expires: new Date("2026-11-15T12:00:00Z"),
  }));
});

const vars = (i = 0) => mockRenderAndWrap.mock.calls[i][1] as Record<string, string>;

describe("bulk registration form", () => {
  it("checks and stamps first, sends only the ready people, and reports the rest", async () => {
    const res = await executeBulkEmail({
      ...BASE_INPUT,
      filters: { registrationFormRate: "Early Bird", registrationFormExpiryDays: 30, registrationFormSponsorId: "sp-1" },
    });
    expect(prepareMock.mock.calls[0][0]).toMatchObject({
      eventId: "evt-1", registrationIds: ["reg-jane", "reg-bob"], rate: { kind: "rate", slug: "early-bird" },
      sponsorId: "sp-1", actorUserId: "user-1", source: "bulk",
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ successCount: 1, skippedCount: 1, skippedReason: "already completed (has an account): 1" });
  });

  it("each person's own link, at the chosen lifetime", async () => {
    await executeBulkEmail({ ...BASE_INPUT, filters: { registrationFormRate: "early-bird", registrationFormExpiryDays: 30 } });
    expect(mintMock.mock.calls[0][0]).toMatchObject({ registrationId: "reg-jane", rate: { kind: "rate", slug: "early-bird" }, expiryDays: 30 });
    expect(vars()).toMatchObject({
      registrationFormLink: "https://x.test/e/oopvf/complete-registration?token=reg-jane",
      rateName: "Early Bird",
      linkExpiresIn: "30 days",
    });
    expect(vars().linkExpiresOn).toMatch(/2026/);
  });

  it("complimentary, and the lifetime defaults to 7 days", async () => {
    await executeBulkEmail({ ...BASE_INPUT, filters: { registrationFormRate: "complimentary" } });
    expect(prepareMock.mock.calls[0][0].rate).toEqual({ kind: "complimentary" });
    expect(mintMock.mock.calls[0][0].expiryDays).toBe(7);
  });

  it("a refusal (unknown rate) stops the send before anyone is emailed", async () => {
    prepareMock.mockResolvedValue({ ok: false, code: "RATE_NOT_FOUND", message: "No registration type on this event has that rate." });
    await expect(executeBulkEmail({ ...BASE_INPUT, filters: { registrationFormRate: "onsite" } })).rejects.toMatchObject({ status: 400 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("refuses a send with no rate, and any audience but registrations", async () => {
    await expect(executeBulkEmail({ ...BASE_INPUT })).rejects.toMatchObject({ status: 400 });
    await expect(executeBulkEmail({ ...BASE_INPUT, recipientType: "speakers", filters: { registrationFormRate: "early-bird" } })).rejects.toMatchObject({ status: 400 });
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
