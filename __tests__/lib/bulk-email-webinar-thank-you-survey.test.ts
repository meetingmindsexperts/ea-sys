/**
 * executeBulkEmail: the webinar thank-you carries each recipient's personal
 * link to the end-of-webinar survey (step 5 of several surveys, Oct 6, 2026).
 *
 * Runs the REAL renderer over the default and saved templates and asserts on
 * what sendEmail receives. The CME survey is never linked, someone who already
 * answered on the attendee page gets no link, and minting the extra survey's
 * link never touches the person's CME link (`survey:{regId}`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockGetEventTemplate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    verificationToken: { deleteMany: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    emailLog: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    survey: { findFirst: vi.fn() },
    surveyResponse: { findMany: vi.fn() },
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
import { withThankYouSurveyBlock } from "@/lib/webinar-thank-you-survey";

const EVENT = (webinar: Record<string, unknown>) => ({
  id: "evt-1",
  slug: "web-1",
  name: "Best of EHA",
  eventType: "WEBINAR",
  startDate: new Date("2026-10-06"),
  endDate: new Date("2026-10-06"),
  timezone: "Asia/Dubai",
  venue: null,
  address: null,
  city: null,
  country: null,
  settings: { webinar: { sessionId: "s1", ...webinar } },
  emailFromAddress: null,
  emailFromName: null,
  emailCcAddresses: [],
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  speakerAgreementTemplate: null,
  speakerAgreementHtml: null,
  surveyConfig: [{ id: "q1", type: "rating_1_to_5", label: "CME", required: true }],
  taxRate: null,
  taxLabel: null,
});

const FEEDBACK = {
  id: "svy-fb",
  name: "Webinar feedback",
  isActive: true,
  gatesCertificates: false,
  config: [{ id: "f1", type: "rating_1_to_5", label: "Useful?", required: true }],
};

const REG = {
  id: "reg-1",
  serialId: 1,
  qrCode: "QR1",
  attendanceMode: "VIRTUAL",
  originalPrice: null,
  discountAmount: null,
  pricingTier: null,
  ticketType: { name: "Delegate", price: 0, currency: "USD" },
  attendee: { email: "delegate@hospital.com", additionalEmail: null, firstName: "Sara", lastName: "Al Harthy", title: "DR" },
};

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "webinar-thank-you" as const,
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

beforeEach(() => {
  for (const group of Object.values(mockDb)) for (const fn of Object.values(group)) fn.mockReset();
  mockSendEmail.mockReset().mockResolvedValue({ success: true, messageId: "m1" });
  mockGetEventTemplate.mockReset().mockResolvedValue(null);
  // Minting hashes the token with NEXTAUTH_SECRET; CI has no .env.
  process.env.NEXTAUTH_SECRET = "test-secret-thank-you-survey";
  mockDb.event.findFirst.mockResolvedValue(EVENT({ endSurveyId: "svy-fb" }));
  mockDb.registration.findMany.mockResolvedValue([REG]);
  mockDb.eventSession.findFirst.mockResolvedValue({ startTime: new Date("2026-10-06T08:00:00Z"), endTime: new Date("2026-10-06T09:00:00Z") });
  mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
  mockDb.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.verificationToken.create.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.emailLog.findMany.mockResolvedValue([]);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.survey.findFirst.mockResolvedValue(FEEDBACK);
  mockDb.surveyResponse.findMany.mockResolvedValue([]);
});

function sent(): { htmlContent: string; textContent?: string } {
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  return mockSendEmail.mock.calls[0][0] as { htmlContent: string; textContent?: string };
}

describe("webinar thank-you: the end-of-webinar survey link", () => {
  it("survey chosen: each recipient gets their personal three-part link, and the CME link is left alive", async () => {
    await executeBulkEmail(INPUT);
    const { htmlContent, textContent } = sent();
    expect(htmlContent).toContain("Take the survey");
    expect(htmlContent).toMatch(/\/e\/web-1\/survey\?token=[0-9a-f]{64}/);
    expect(htmlContent).not.toContain("{{surveyBlock}}");
    expect(textContent ?? "").toMatch(/Tell us what you thought: http\S+\/e\/web-1\/survey\?token=[0-9a-f]{64}/);
    expect(mockDb.verificationToken.create.mock.calls[0][0].data.identifier).toBe("survey:svy-fb:reg-1");
    // Only this survey's link is replaced; `survey:reg-1` (the CME link) is never deleted.
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { identifier: "survey:svy-fb:reg-1" } });
    for (const call of mockDb.verificationToken.deleteMany.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('"survey:reg-1"');
    }
  });

  it("no survey chosen: the thank-you is as before, nothing minted", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({}));
    await executeBulkEmail(INPUT);
    const { htmlContent } = sent();
    expect(htmlContent).not.toContain("Take the survey");
    expect(htmlContent).not.toContain("{{survey");
    expect(mockDb.survey.findFirst).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
  });

  it("someone who already answered on the attendee page gets no link", async () => {
    mockDb.surveyResponse.findMany.mockResolvedValue([{ registrationId: "reg-1" }]);
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).not.toContain("Take the survey");
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
    expect(mockDb.surveyResponse.findMany.mock.calls[0][0].where).toEqual({
      surveyId: "svy-fb",
      registrationId: { in: ["reg-1"] },
    });
  });

  it("a daily survey: only an answer TODAY (event timezone) skips the link (Phase 4)", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ ...FEEDBACK, responseMode: "ONCE_PER_DAY" });
    await executeBulkEmail(INPUT);
    const where = mockDb.surveyResponse.findMany.mock.calls[0][0].where;
    expect(where.surveyId).toBe("svy-fb");
    expect(where.dedupKey.in[0]).toMatch(/^reg-1:\d{4}-\d{2}-\d{2}$/);
    expect(where.registrationId).toBeUndefined();
  });

  it("NEVER the CME survey, even if it were set", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ ...FEEDBACK, gatesCertificates: true });
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).not.toContain("Take the survey");
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.deleteMany).not.toHaveBeenCalled();
  });

  it("a closed survey: the thank-you still goes, without the link", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ ...FEEDBACK, isActive: false });
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).not.toContain("Take the survey");
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
  });

  it("a saved template without the token gets the button before the signature", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Thanks for joining",
      htmlContent: "<p>Thanks for joining.</p><p>SIGNATURE-START</p>{{organizerSignature}}",
      textContent: "Thanks for joining.\n{{organizerSignature}}",
      branding: {},
    });
    await executeBulkEmail(INPUT);
    const { htmlContent } = sent();
    expect(htmlContent).toContain("Take the survey");
    expect(htmlContent.indexOf("Thanks for joining.")).toBeLessThan(htmlContent.indexOf("Take the survey"));
  });

  it("a saved template carrying {{surveyBlock}} sends cleanly when there is no survey (no unresolved-token abort)", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({}));
    mockGetEventTemplate.mockResolvedValue({
      subject: "Thanks for joining",
      htmlContent: "<p>Thanks.</p>{{surveyBlock}}",
      textContent: "Thanks.\n{{surveyBlockText}}",
      branding: {},
    });
    await executeBulkEmail(INPUT);
    const { htmlContent } = sent();
    expect(htmlContent).not.toContain("{{surveyBlock}}");
    expect(htmlContent).not.toContain("Take the survey");
  });

  it("the organiser turned the email link off: no link, nothing minted, the survey not even read", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({ endSurveyId: "svy-fb", thankYouSurveyLink: false }));
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).not.toContain("Take the survey");
    expect(mockDb.survey.findFirst).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
  });

  it("switched on explicitly behaves as unset", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({ endSurveyId: "svy-fb", thankYouSurveyLink: true }));
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).toContain("Take the survey");
  });
});

describe("withThankYouSurveyBlock: each part on its own (review of steps 1 to 5)", () => {
  it("a token only in the text part: the text is left alone, the HTML gains the block", () => {
    const out = withThankYouSurveyBlock({ htmlContent: "<p>Hi</p>", textContent: "Hi\n{{surveyBlockText}}" });
    expect(out.textContent).toBe("Hi\n{{surveyBlockText}}");
    expect(out.htmlContent).toBe("<p>Hi</p>\n{{surveyBlock}}");
  });

  it("a token only in the HTML: the HTML is left alone, the text gains the line before the signature", () => {
    const out = withThankYouSurveyBlock({ htmlContent: "<p>Hi</p>{{surveyBlock}}", textContent: "Hi\n{{organizerSignature}}" });
    expect(out.htmlContent).toBe("<p>Hi</p>{{surveyBlock}}");
    expect(out.textContent).toBe("Hi\n{{surveyBlockText}}\n{{organizerSignature}}");
  });

  it("a part using {{surveyLink}} directly is left as written; a null text part stays null", () => {
    const out = withThankYouSurveyBlock({ htmlContent: '<a href="{{surveyLink}}">Go</a>', textContent: null });
    expect(out.htmlContent).toBe('<a href="{{surveyLink}}">Go</a>');
    expect(out.textContent).toBeNull();
  });
});
