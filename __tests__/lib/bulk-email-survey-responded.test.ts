/**
 * executeBulkEmail: the "Answered / Not answered <survey>" audience filter
 * (several surveys, Phase 2, Oct 6, 2026). Derived from the response rows;
 * registrations only; the survey must be this event's; applied at fire time.
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

const EVENT = {
  id: "evt-1",
  slug: "conf",
  name: "Conference",
  eventType: "CONFERENCE",
  startDate: new Date("2026-10-06"),
  endDate: new Date("2026-10-06"),
  timezone: "Asia/Dubai",
  venue: null,
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
  surveyConfig: null,
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
  attendee: { email: "delegate@hospital.com", additionalEmail: null, firstName: "Sara", lastName: "Al Harthy", title: "DR" },
  paymentStatus: "COMPLIMENTARY",
  group: null,
};

const INPUT = (surveyResponded?: { surveyId: string; answered: "yes" | "no" }, recipientType: "registrations" | "speakers" = "registrations") => ({
  eventId: "evt-1",
  recipientType,
  emailType: "custom" as const,
  customSubject: "Reminder",
  customMessage: "Please fill in the survey.",
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
  ...(surveyResponded ? { filters: { surveyResponded } } : {}),
});

beforeEach(() => {
  for (const group of Object.values(mockDb)) for (const fn of Object.values(group)) fn.mockReset();
  mockSendEmail.mockReset().mockResolvedValue({ success: true, messageId: "m1" });
  mockGetEventTemplate.mockReset().mockResolvedValue(null);
  process.env.NEXTAUTH_SECRET = "test-secret-responded";
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([REG]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.emailLog.findMany.mockResolvedValue([]);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.survey.findFirst.mockResolvedValue({ id: "svy-fb", eventId: "evt-1", gatesCertificates: false });
});

const where = () => mockDb.registration.findMany.mock.calls[0][0].where;

describe("the survey responded filter on a registrations send", () => {
  it("not answered: registrations with NO response to that survey", async () => {
    await executeBulkEmail(INPUT({ surveyId: "svy-fb", answered: "no" }));
    expect(where().surveyResponses).toEqual({ none: { surveyId: "svy-fb" } });
    expect(mockDb.survey.findFirst.mock.calls[0][0].where).toEqual({ id: "svy-fb", eventId: "evt-1" });
  });

  it("answered: registrations with a response", async () => {
    await executeBulkEmail(INPUT({ surveyId: "svy-fb", answered: "yes" }));
    expect(where().surveyResponses).toEqual({ some: { surveyId: "svy-fb" } });
  });

  it("the CME survey counts its legacy rows too (the same rule as its results)", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ id: "svy-cme", eventId: "evt-1", gatesCertificates: true });
    await executeBulkEmail(INPUT({ surveyId: "svy-cme", answered: "no" }));
    expect(where().surveyResponses).toEqual({
      none: { eventId: "evt-1", OR: [{ surveyId: "svy-cme" }, { surveyId: null }] },
    });
  });

  it("no filter: the audience is unchanged", async () => {
    await executeBulkEmail(INPUT());
    expect(where().surveyResponses).toBeUndefined();
    expect(mockDb.survey.findFirst).not.toHaveBeenCalled();
  });

  it("another event's survey is refused before anything is sent", async () => {
    mockDb.survey.findFirst.mockResolvedValue(null);
    await expect(executeBulkEmail(INPUT({ surveyId: "foreign", answered: "no" }))).rejects.toMatchObject({ status: 400 });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("refused for an audience other than registrations", async () => {
    await expect(executeBulkEmail(INPUT({ surveyId: "svy-fb", answered: "no" }, "speakers"))).rejects.toMatchObject({ status: 400 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
