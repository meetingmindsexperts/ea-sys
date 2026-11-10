/**
 * executeBulkEmail: the webinar thank-you and the replay (Nov 10, 2026).
 *
 * An organiser's uploaded replay is never linked directly: the Watch Replay button opens the
 * person's replay page in their portal (/my-account/replay/{eventId}), which checks the
 * registration, plays it, and keeps working after the event is marked Completed. The thank-you
 * goes out about half an hour after the room closes, usually before anything is uploaded, so the
 * "coming shortly" line links the same page. Zoom's recording keeps its own link. Runs the REAL
 * renderer and the REAL rule (webinar/replay.ts) and asserts on what sendEmail receives.
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

const VIMEO = "https://vimeo.com/123456789/abcdef1234";
const PAGE = /https?:\/\/[^"\s/]+\/my-account\/replay\/evt-1/;

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
  surveyConfig: null,
  taxRate: null,
  taxLabel: null,
});

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

const CLOSED = { startTime: new Date("2026-10-06T08:00:00Z"), endTime: new Date("2026-10-06T09:00:00Z"), status: "COMPLETED" };
const ZOOM = { joinUrl: "https://zoom.us/j/1", recordingUrl: "https://zoom.us/rec/play/abc", recordingPassword: "pw", recordingStatus: "AVAILABLE" };

beforeEach(() => {
  for (const group of Object.values(mockDb)) for (const fn of Object.values(group)) fn.mockReset();
  mockSendEmail.mockReset().mockResolvedValue({ success: true, messageId: "m1" });
  mockGetEventTemplate.mockReset().mockResolvedValue(null);
  process.env.NEXTAUTH_SECRET = "test-secret-webinar-replay";
  mockDb.event.findFirst.mockResolvedValue(EVENT({ showRecording: true, replayUrl: VIMEO }));
  mockDb.registration.findMany.mockResolvedValue([REG]);
  mockDb.eventSession.findFirst.mockResolvedValue(CLOSED);
  mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
  mockDb.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.verificationToken.create.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.emailLog.findMany.mockResolvedValue([]);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.surveyResponse.findMany.mockResolvedValue([]);
});

function sent(): { htmlContent: string; textContent?: string } {
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  return mockSendEmail.mock.calls[0][0] as { htmlContent: string; textContent?: string };
}

describe("webinar thank-you: the replay", () => {
  it("an uploaded replay: Watch Replay opens the person's replay page, and the Vimeo link is never in the email", async () => {
    await executeBulkEmail(INPUT);
    const { htmlContent, textContent } = sent();
    expect(htmlContent).toContain("Watch Replay");
    expect(htmlContent).toMatch(new RegExp(`href="${PAGE.source}"[^>]*>Watch Replay`));
    expect(textContent ?? "").toMatch(new RegExp(`Watch replay: ${PAGE.source}`));
    for (const body of [htmlContent, textContent ?? ""]) {
      expect(body).not.toContain("vimeo");
      expect(body).not.toContain("123456789");
    }
  });

  it("the uploaded replay wins over a fetched Zoom recording, whose link is then not sent", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM);
    await executeBulkEmail(INPUT);
    const { htmlContent } = sent();
    expect(htmlContent).toMatch(new RegExp(`href="${PAGE.source}"[^>]*>Watch Replay`));
    expect(htmlContent).not.toContain("zoom.us/rec");
  });

  it("switched on, nothing uploaded or fetched yet: it says where the recording will be, with a link there", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({ showRecording: true }));
    await executeBulkEmail(INPUT);
    const { htmlContent, textContent } = sent();
    expect(htmlContent).toContain("The recording will be available shortly. You can watch it here once it is ready.");
    expect(htmlContent).toMatch(new RegExp(`href="${PAGE.source}"[^>]*>Open the replay page`));
    expect(htmlContent).not.toContain("Watch Replay");
    expect(htmlContent).not.toContain("send it to you");
    expect(textContent ?? "").toMatch(new RegExp(`available shortly\\. Watch it here once it is ready: ${PAGE.source}`));
  });

  it("no upload, Zoom's recording fetched: its own link, as before", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({ showRecording: true }));
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM);
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).toContain('href="https://zoom.us/rec/play/abc"');
  });

  it("the organiser's switch off: the email neither links nor promises a recording, upload or not", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT({ replayUrl: VIMEO }));
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM);
    await executeBulkEmail(INPUT);
    const { htmlContent } = sent();
    expect(htmlContent).not.toContain("Watch Replay");
    expect(htmlContent).not.toContain("available shortly");
    expect(htmlContent).not.toContain("zoom.us/rec");
    expect(htmlContent).not.toContain("{{recordingBlock}}");
  });

  it("the plain-text part carries the replay as a text line, never the button's HTML", async () => {
    await executeBulkEmail(INPUT);
    const text = sent().textContent ?? "";
    expect(text).toMatch(new RegExp(`Watch replay: ${PAGE.source}`));
    expect(text).not.toContain("<div");
    expect(text).not.toContain("<a ");
    expect(text).not.toContain("{{recordingBlock");
  });

  it("the join link still opens the webinar's own page: only the replay moved to the portal", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Thanks",
      htmlContent: "<p>{{joinUrl}}</p>{{recordingBlock}}",
      textContent: "{{joinUrl}}",
    });
    await executeBulkEmail(INPUT);
    expect(sent().htmlContent).toMatch(/\/e\/web-1\/session\/s1/);
  });

  it("says how to get in: sign in with the address you registered with", async () => {
    await executeBulkEmail(INPUT);
    const { htmlContent, textContent } = sent();
    expect(htmlContent).toContain("Sign in with the email address you registered with");
    expect(textContent ?? "").toContain("Sign in with the email address you registered with");
  });

  it("a template SAVED before this release, with {{recordingBlock}} in its text part: text there, never the button's HTML", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Thank you",
      htmlContent: "<p>Thanks</p>{{recordingBlock}}",
      textContent: "Thanks\n\n{{recordingBlock}}",
    });
    await executeBulkEmail(INPUT);
    const { htmlContent, textContent } = sent();
    expect(htmlContent).toMatch(new RegExp(`href="${PAGE.source}"[^>]*>Watch Replay`));
    expect(textContent ?? "").toMatch(new RegExp(`Watch replay: ${PAGE.source}`));
    expect(textContent ?? "").not.toContain("<div");
    expect(textContent ?? "").not.toContain("<a ");
  });

  it("an event that is not a WEBINAR is never sent to the replay page, which answers for webinars only", async () => {
    // Two conferences on production carry webinar settings; the portal page would refuse everyone.
    const conference = (webinar: Record<string, unknown>) => ({ ...EVENT(webinar), eventType: "CONFERENCE" });
    mockDb.event.findFirst.mockResolvedValue(conference({ showRecording: true, replayUrl: VIMEO }));
    await executeBulkEmail(INPUT);
    const pending = sent().htmlContent;
    expect(pending).not.toContain("/my-account/replay/");
    expect(pending).not.toContain("Watch Replay");
    expect(pending).toContain("The recording will be available shortly.");

    mockSendEmail.mockClear();
    mockDb.event.findFirst.mockResolvedValue(conference({ showRecording: true, replayUrl: VIMEO }));
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM);
    await executeBulkEmail(INPUT);
    const zoom = sent().htmlContent;
    expect(zoom).toContain('href="https://zoom.us/rec/play/abc"');
    expect(zoom).not.toContain("/my-account/replay/");
  });
});
