/**
 * executeBulkEmail (bulk-email.ts) — per-recipient send idempotency (review H1).
 *
 * A re-run (worker retry after a crash) must SKIP recipients a prior run already
 * emailed (via input.alreadyEmailedKeys) and REPORT each batch's sent ids (via
 * input.onBatchEmailed) so the worker can persist progress to
 * ScheduledEmail.emailedKeys. A fresh send skips nobody. Heavy branches
 * (render, send) are mocked; we assert the skip + record contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockRenderAndWrap, mockGetDefaultTemplate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
  },
  mockSendEmail: vi.fn(),
  mockRenderAndWrap: vi.fn(),
  mockGetDefaultTemplate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (args: unknown) => mockSendEmail(args),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: (slug: string) => mockGetDefaultTemplate(slug),
  renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com", name: "From" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
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

function reg(id: string, email: string) {
  return {
    id,
    serialId: 1,
    qrCode: null,
    attendanceMode: "IN_PERSON",
    originalPrice: null,
    discountAmount: null,
    pricingTier: null,
    ticketType: { name: "Physician", price: 0, currency: "USD" },
    attendee: { email, additionalEmail: null, firstName: "A", lastName: "B", title: "DR" },
  };
}

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "custom" as const,
  customSubject: "Hi",
  customMessage: "<p>Body</p>",
  filters: {},
  organizerName: "Org",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([reg("reg1", "a@x.com"), reg("reg2", "b@x.com")]);
  mockGetDefaultTemplate.mockReturnValue({ htmlContent: "<p>{{message}}</p>", textContent: "{{message}}" });
  mockRenderAndWrap.mockReturnValue({ subject: "Hi", htmlContent: "<p>Body</p>", textContent: "Body" });
  mockSendEmail.mockResolvedValue({ success: true });
});

describe("executeBulkEmail — per-recipient idempotency (H1)", () => {
  it("emails everyone and reports every id on a fresh send", async () => {
    const onBatchEmailed = vi.fn().mockResolvedValue(undefined);
    const res = await executeBulkEmail({ ...INPUT, onBatchEmailed });

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(res.total).toBe(2);
    expect(res.successCount).toBe(2);
    // Both ids recorded for idempotency.
    const recorded = onBatchEmailed.mock.calls.flatMap((c) => c[0]);
    expect(recorded.sort()).toEqual(["reg1", "reg2"]);
  });

  it("skips an already-emailed recipient on a re-run (does not re-send)", async () => {
    const onBatchEmailed = vi.fn().mockResolvedValue(undefined);
    const res = await executeBulkEmail({
      ...INPUT,
      alreadyEmailedKeys: ["reg1"],
      onBatchEmailed,
    });

    // Only reg2 is emailed — reg1 already got it before the crash.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sentTo = mockSendEmail.mock.calls[0][0].to[0].email;
    expect(sentTo).toBe("b@x.com");
    // total reflects what this run attempted (the remaining one).
    expect(res.total).toBe(1);
    const recorded = onBatchEmailed.mock.calls.flatMap((c) => c[0]);
    expect(recorded).toEqual(["reg2"]);
  });

  it("sends nothing when every recipient was already emailed (completed retry)", async () => {
    const onBatchEmailed = vi.fn().mockResolvedValue(undefined);
    const res = await executeBulkEmail({
      ...INPUT,
      alreadyEmailedKeys: ["reg1", "reg2"],
      onBatchEmailed,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(res.total).toBe(0);
    expect(res.successCount).toBe(0);
    expect(onBatchEmailed).not.toHaveBeenCalled();
  });

  it("a record failure does not fail the send", async () => {
    const onBatchEmailed = vi.fn().mockRejectedValue(new Error("db blip"));
    const res = await executeBulkEmail({ ...INPUT, onBatchEmailed });
    // Emails still went out despite the idempotency-record failure.
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(res.successCount).toBe(2);
  });
});
