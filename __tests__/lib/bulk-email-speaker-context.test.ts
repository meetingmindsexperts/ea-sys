/**
 * executeBulkEmail — {{presentationDetails}} must resolve for EVERY email
 * type sent to speakers, not just invitation/agreement.
 *
 * Organizer-reported bug (July 16, 2026): a saved custom template (emailType
 * "template") or a custom email sent to speakers rendered an empty
 * {{presentationDetails}} block — the per-speaker context (sessions, topics,
 * dates) was only built for the invitation/agreement types, so the speaker's
 * assigned sessions silently vanished from the email.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockRenderAndWrap, mockGetDefaultTemplate, mockGetEventTemplate, mockBuildSpeakerEmailContext } =
  vi.hoisted(() => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn() },
    },
    mockSendEmail: vi.fn(),
    mockRenderAndWrap: vi.fn(),
    mockGetDefaultTemplate: vi.fn(),
    mockGetEventTemplate: vi.fn(),
    mockBuildSpeakerEmailContext: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (args: unknown) => mockSendEmail(args),
  getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
  getDefaultTemplate: (slug: string) => mockGetDefaultTemplate(slug),
  renderMessageValue: vi.fn((m: string) => m),
  renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com", name: "From" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/speaker-agreement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speaker-agreement")>();
  return {
    ...actual,
    buildSpeakerEmailContext: (...args: unknown[]) => mockBuildSpeakerEmailContext(...args),
    generateSpeakerAgreementDocx: vi.fn(),
    generateSpeakerAgreementPdf: vi.fn(),
    pickAgreementAttachmentMode: vi.fn(),
    mintSpeakerAgreementLink: vi.fn().mockResolvedValue("https://x.com/agree"),
  };
});
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  slug: "osh",
  name: "OSH",
  startDate: new Date("2026-07-01"),
  venue: "Dubai",
  address: null,
  settings: {},
  emailFromAddress: "from@x.com",
  emailFromName: "From",
  emailCcAddresses: null,
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  speakerAgreementTemplate: null,
  speakerAgreementHtml: null,
  surveyConfig: null,
  taxRate: null,
  taxLabel: null,
};

const SPEAKER = {
  id: "spk-1",
  email: "dr@x.com",
  additionalEmail: null,
  firstName: "Aisha",
  lastName: "Khan",
  title: "DR",
};

const CONTEXT = {
  title: "Dr.",
  speakerName: "Dr. Aisha Khan",
  presentationDetails: "<table><tr><td>Session</td><td>Opening Keynote</td></tr></table>",
  presentationDetailsText: "Session: Opening Keynote",
  sessionTitles: "Opening Keynote",
};

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "speakers" as const,
  filters: {},
  organizerName: "Org",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speaker.findMany.mockResolvedValue([SPEAKER]);
  mockGetEventTemplate.mockResolvedValue({
    subject: "{{eventName}}",
    htmlContent: "<p>Dear {{speakerName}}</p>{{presentationDetails}}",
    textContent: "{{presentationDetailsText}}",
  });
  mockGetDefaultTemplate.mockReturnValue({
    subject: "{{eventName}}",
    htmlContent: "<p>{{message}}</p>{{presentationDetails}}",
    textContent: "{{message}}",
  });
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
  mockBuildSpeakerEmailContext.mockResolvedValue(CONTEXT);
});

function varsHandedToRenderer(): Record<string, unknown> {
  expect(mockRenderAndWrap).toHaveBeenCalled();
  return mockRenderAndWrap.mock.calls[0][1] as Record<string, unknown>;
}

describe("executeBulkEmail — speaker context for every email type", () => {
  it("builds the context for a SAVED custom template send (emailType 'template')", async () => {
    await executeBulkEmail({
      ...BASE_INPUT,
      emailType: "template",
      filters: { templateSlug: "my-custom-speaker-blast" },
    });
    expect(mockBuildSpeakerEmailContext).toHaveBeenCalledWith("evt-1", "spk-1");
    const vars = varsHandedToRenderer();
    expect(vars.presentationDetails).toBe(CONTEXT.presentationDetails);
    expect(vars.presentationDetailsText).toBe(CONTEXT.presentationDetailsText);
    expect(vars.speakerName).toBe("Dr. Aisha Khan");
  });

  it("builds the context for a custom send (emailType 'custom')", async () => {
    await executeBulkEmail({
      ...BASE_INPUT,
      emailType: "custom",
      customSubject: "Hello",
      customMessage: "See your sessions below.",
    });
    expect(mockBuildSpeakerEmailContext).toHaveBeenCalledWith("evt-1", "spk-1");
    const vars = varsHandedToRenderer();
    expect(vars.presentationDetails).toBe(CONTEXT.presentationDetails);
  });

  it("still builds the context for invitation sends (unchanged behavior)", async () => {
    await executeBulkEmail({ ...BASE_INPUT, emailType: "invitation" });
    expect(mockBuildSpeakerEmailContext).toHaveBeenCalledWith("evt-1", "spk-1");
    const vars = varsHandedToRenderer();
    expect(vars.presentationDetails).toBe(CONTEXT.presentationDetails);
  });

  it("degrades to empty tokens (not a crash) when the context lookup returns null", async () => {
    mockBuildSpeakerEmailContext.mockResolvedValue(null);
    const res = await executeBulkEmail({
      ...BASE_INPUT,
      emailType: "custom",
      customSubject: "Hello",
      customMessage: "Body",
    });
    expect(res.successCount).toBe(1);
    const vars = varsHandedToRenderer();
    expect(vars.presentationDetails).toBe("");
  });

  it("does NOT build speaker context for registration recipients", async () => {
    mockDb.speaker.findMany.mockResolvedValue([]);
    const regDb = mockDb as unknown as {
      registration: { findMany: ReturnType<typeof vi.fn> };
    };
    regDb.registration = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "reg1",
          serialId: 1,
          qrCode: null,
          attendanceMode: "IN_PERSON",
          originalPrice: null,
          discountAmount: null,
          pricingTier: null,
          ticketType: { name: "Physician", price: 0, currency: "USD" },
          attendee: { email: "a@x.com", additionalEmail: null, firstName: "A", lastName: "B", title: "DR" },
        },
      ]),
    };
    await executeBulkEmail({
      ...BASE_INPUT,
      recipientType: "registrations",
      emailType: "custom",
      customSubject: "Hello",
      customMessage: "Body",
    });
    expect(mockBuildSpeakerEmailContext).not.toHaveBeenCalled();
  });
});
