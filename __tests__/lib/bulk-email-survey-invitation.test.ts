/**
 * executeBulkEmail — the Survey Invitation delivers each recipient's PERSONAL
 * link, whatever the saved template says (Sep 17, 2026).
 *
 * Production case: the Oman Oncology event's saved survey-invitation template
 * had its `{{surveyLink}}` replaced by the event's shareable URL, so the send
 * minted a personal token and emailed the shared link. This runs the REAL
 * renderer over that template and asserts on what sendEmail receives, because
 * a test of the helper alone would pass even if the send never called it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockGetEventTemplate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    verificationToken: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    // The event's surveys (step 3). Null by default = an event with no Survey
    // row, which mints the legacy two-part link (the CME survey).
    survey: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
    loadActiveEventTemplateRow: vi.fn(),
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

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  slug: "OOPVF2026",
  name: "Oman Oncology Pharmacy Value Forum 2026",
  startDate: new Date("2026-09-12"),
  endDate: new Date("2026-09-12"),
  timezone: "Asia/Muscat",
  venue: "Muscat",
  address: null,
  city: null,
  country: null,
  settings: {},
  emailFromAddress: null,
  emailFromName: null,
  emailCcAddresses: [],
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  speakerAgreementTemplate: null,
  speakerAgreementHtml: null,
  surveyConfig: [{ id: "q1", type: "rating_1_to_5", label: "Overall", required: true }],
  taxRate: null,
  taxLabel: null,
};

const REG = {
  id: "reg-1",
  serialId: 1,
  qrCode: "QR1",
  attendanceMode: "IN_PERSON",
  originalPrice: null,
  discountAmount: null,
  pricingTier: null,
  ticketType: { name: "Delegate", price: 0, currency: "USD" },
  attendee: {
    email: "delegate@hospital.com",
    additionalEmail: null,
    firstName: "Sara",
    lastName: "Al Harthy",
    title: "DR",
  },
};

const SHARE_URL = "https://events.meetingmindsgroup.com/e/OOPVF2026/survey?share=9f2c1b7e4d";

function savedTemplate(htmlContent: string, textContent: string | null) {
  return {
    subject: "Your Insights Matter: Help Shape the Future of Oncology Pharmacy",
    htmlContent,
    textContent,
    branding: {},
  };
}

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "survey-invitation" as const,
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Minting the survey token hashes it with NEXTAUTH_SECRET. Locally .env
  // supplies it; CI has none, and without it the per-recipient hash throws and
  // nothing is sent. Set it here so the test cannot depend on the machine.
  process.env.NEXTAUTH_SECRET = "test-secret-survey-invitation";
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([REG]);
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
});

function sentHtml(): string {
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  return (mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent;
}

describe("Survey Invitation send", () => {
  it("delivers the personal ?token= link where the organizer pasted the shareable URL", async () => {
    mockGetEventTemplate.mockResolvedValue(
      savedTemplate(
        `<p>Dear {{title}} {{lastName}},</p><p><a href="${SHARE_URL}">Take the survey</a></p>`,
        "Take the survey: {{surveyLink}}",
      ),
    );

    const res = await executeBulkEmail({ ...INPUT, filters: {} });

    expect(res.successCount).toBe(1);
    const html = sentHtml();
    expect(html).toMatch(/\/e\/OOPVF2026\/survey\?token=[0-9a-f]{64}/);
    expect(html).not.toContain("share=");
    // The rendered name proves the bulk path fills the placeholders the old
    // "email me my link" sender left unresolved.
    expect(html).toContain("Al Harthy");
  });

  it("adds a personal button when the saved template has no survey link at all", async () => {
    mockGetEventTemplate.mockResolvedValue(
      savedTemplate("<p>Dear {{firstName}}, please tell us how it went.</p>", null),
    );

    await executeBulkEmail({ ...INPUT, filters: {} });

    const html = sentHtml();
    expect(html).toMatch(/href="[^"]*\/survey\?token=[0-9a-f]{64}"/);
    expect(html).toContain("Take the survey");
  });

  it("mints the token with the organizer's typed expiry (45 days)", async () => {
    mockGetEventTemplate.mockResolvedValue(
      savedTemplate('<a href="{{surveyLink}}">Take the survey</a>', "{{surveyLink}}"),
    );
    const before = Date.now();

    await executeBulkEmail({ ...INPUT, filters: { surveyExpiryDays: 45 } });

    const expires = (mockDb.verificationToken.create.mock.calls[0][0] as { data: { expires: Date } }).data
      .expires;
    const days = (expires.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(44.99);
    expect(days).toBeLessThan(45.01);
  });
});

describe("survey-invitation links name their survey (step 3, Oct 6, 2026)", () => {
  const ROW = (over: Record<string, unknown>) => ({
    id: "svy-cert", eventId: "evt-1", name: "Post-event survey", config: [{ id: "q1", type: "rating_1_to_5", label: "Overall", required: true }],
    introHtml: null, thankYouHtml: null, isActive: true, sortOrder: 0, gatesCertificates: true, responseMode: "ONCE",
    createdAt: new Date(0), updatedAt: new Date(0), ...over,
  });

  it("the CME survey's link is byte-identical to before (survey:{regId}), and a re-send revokes both forms", async () => {
    mockGetEventTemplate.mockResolvedValue(savedTemplate('<a href="{{surveyLink}}">Go</a>', "{{surveyLink}}"));
    mockDb.survey.findFirst.mockResolvedValue(ROW({}));
    await executeBulkEmail(INPUT);
    const identifier = mockDb.verificationToken.create.mock.calls[0][0].data.identifier as string;
    expect(identifier).toMatch(/^survey:[^:]+$/); // two parts, as every link already in inboxes
    const revoked = mockDb.verificationToken.deleteMany.mock.calls[0][0].where.identifier.in as string[];
    expect(revoked).toContain(identifier);
    expect(revoked.some((i) => i.startsWith("survey:svy-cert:"))).toBe(true);
  });

  it("a chosen extra survey gets its own link", async () => {
    mockGetEventTemplate.mockResolvedValue(savedTemplate('<a href="{{surveyLink}}">Go</a>', "{{surveyLink}}"));
    mockDb.survey.findFirst.mockResolvedValue(ROW({ id: "svy-fb", name: "Webinar feedback", gatesCertificates: false }));
    await executeBulkEmail({ ...INPUT, filters: { surveyId: "svy-fb" } });
    expect(mockDb.verificationToken.create.mock.calls[0][0].data.identifier).toMatch(/^survey:svy-fb:/);
    // Only that survey's old link goes: the person's CME link stays alive.
    expect(mockDb.verificationToken.deleteMany.mock.calls[0][0].where.identifier.in).toEqual([
      mockDb.verificationToken.create.mock.calls[0][0].data.identifier,
    ]);
  });

  it("a daily survey's re-send ADDS a link and never revokes the earlier one (review of Phase 4)", async () => {
    mockGetEventTemplate.mockResolvedValue(savedTemplate('<a href="{{surveyLink}}">Go</a>', "{{surveyLink}}"));
    mockDb.survey.findFirst.mockResolvedValue(ROW({ id: "svy-day", name: "Daily", gatesCertificates: false, responseMode: "ONCE_PER_DAY" }));
    await executeBulkEmail({ ...INPUT, filters: { surveyId: "svy-day" } });
    expect(mockDb.verificationToken.create.mock.calls[0][0].data.identifier).toMatch(/^survey:svy-day:/);
    expect(mockDb.verificationToken.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a closed survey before anything is sent", async () => {
    mockDb.survey.findFirst.mockResolvedValue(ROW({ id: "svy-fb", name: "Webinar feedback", gatesCertificates: false, isActive: false }));
    await expect(executeBulkEmail({ ...INPUT, filters: { surveyId: "svy-fb" } })).rejects.toThrow(/closed/);
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
