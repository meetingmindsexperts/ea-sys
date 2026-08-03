/**
 * executeBulkEmail — EmailLog org stamping (Aug 3, 2026).
 *
 * Callers that omit `organizationId` (the automated webinar confirmation,
 * payment reminders) used to write org-NULL EmailLog rows; the strictly
 * org-scoped body route then 404'd the Email Activity "View" button
 * ("Email not found"). executeBulkEmail now defaults the org from the event
 * it already loads — ONE fix covering every caller. These tests pin that
 * default at the sendEmail logContext boundary (the effect, not the call).
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
  organizationId: "org-of-event",
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

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "speakers" as const,
  emailType: "custom" as const,
  customSubject: "Hello",
  customMessage: "World",
  organizerName: "Org",
  organizerEmail: "org@x.com",
  triggeredByUserId: "user-1",
};

function sentLogContext(): { organizationId: string | null } {
  expect(mockSendEmail).toHaveBeenCalled();
  return (mockSendEmail.mock.calls[0][0] as { logContext: { organizationId: string | null } }).logContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speaker.findMany.mockResolvedValue([
    { id: "spk-1", email: "dr@x.com", additionalEmail: null, firstName: "Aisha", lastName: "Khan", title: "DR" },
  ]);
  mockGetEventTemplate.mockResolvedValue({
    subject: "{{eventName}}",
    htmlContent: "<p>{{message}}</p>",
    textContent: "{{message}}",
  });
  mockGetDefaultTemplate.mockReturnValue({
    subject: "{{eventName}}",
    htmlContent: "<p>{{message}}</p>",
    textContent: "{{message}}",
  });
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
  mockBuildSpeakerEmailContext.mockResolvedValue(null);
});

describe("executeBulkEmail — EmailLog org stamp", () => {
  it("defaults logContext.organizationId from the EVENT when the caller omits it", async () => {
    await executeBulkEmail({ ...BASE_INPUT });
    expect(sentLogContext().organizationId).toBe("org-of-event");
  });

  it("a caller-provided organizationId still wins over the event's", async () => {
    await executeBulkEmail({ ...BASE_INPUT, organizationId: "explicit-org" });
    expect(sentLogContext().organizationId).toBe("explicit-org");
  });
});
