/**
 * executeBulkEmail, Registration Confirmation: {{paymentBlock}} is filled from
 * the SAME builder the automatic confirmation uses (September 18, 2026).
 * Before this, bulk had no value for the token, so the "Welcome Paid" tile
 * and a resend on the default template were refused by the unresolved-token
 * guard on every event still carrying it. Runs the REAL renderer over the real
 * default template and asserts on what sendEmail receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockGetEventTemplate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
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
vi.mock("@/lib/email-barcode", () => ({ buildEntryBarcode: vi.fn(), templateUsesEntryBarcode: vi.fn().mockReturnValue(false) }));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));

import { executeBulkEmail } from "@/lib/bulk-email";
import { getDefaultTemplate } from "@/lib/email";

const EVENT = {
  id: "evt-1", slug: "osh", name: "OSH Monthly Meeting 2026",
  startDate: new Date("2026-10-02"), endDate: new Date("2026-10-02"), timezone: "Asia/Dubai",
  venue: "Raffles", address: null, city: "Dubai", country: "UAE", settings: {},
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [],
  emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: null, surveyConfig: null,
  taxRate: 5, taxLabel: "VAT",
};

function reg(extra: Record<string, unknown>) {
  return {
    id: "reg-1", serialId: 3, qrCode: "QR1", attendanceMode: "IN_PERSON",
    originalPrice: 100, discountAmount: null, pricingTier: null,
    ticketType: { name: "Delegate", price: 100, currency: "USD" },
    attendee: { email: "d@h.com", additionalEmail: null, firstName: "Sara", lastName: "Al Harthy", title: "DR" },
    paymentStatus: "UNPAID", group: null,
    ...extra,
  };
}

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "confirmation" as const,
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
  filters: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
  const def = getDefaultTemplate("registration-confirmation")!;
  mockGetEventTemplate.mockResolvedValue({ ...def, branding: {} });
});

function sentHtml(): string {
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  return (mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent;
}

describe("bulk Registration Confirmation {{paymentBlock}}", () => {
  it("an unpaid registration gets the amount, VAT and a Pay Now link, with no quote sentence", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({})]);
    const res = await executeBulkEmail(INPUT);
    expect(res.successCount).toBe(1);
    const html = sentHtml();
    expect(html).toContain("Payment Pending");
    expect(html).toContain("Total: USD 105.00");
    expect(html).toContain("/e/osh/confirmation?id=reg-1");
    expect(html).not.toContain("Please find attached the quote");
    expect(html).not.toContain("{{paymentBlock}}");
  });

  it("a paid registration gets no payment block and no literal token", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ paymentStatus: "PAID" })]);
    await executeBulkEmail(INPUT);
    const html = sentHtml();
    expect(html).not.toContain("Payment Pending");
    expect(html).not.toContain("{{paymentBlock}}");
    expect(html).toContain("Al Harthy");
  });

  it.each(["COMPLIMENTARY", "INCLUSIVE", "REFUNDED"])("%s owes nothing", async (paymentStatus) => {
    mockDb.registration.findMany.mockResolvedValue([reg({ paymentStatus })]);
    await executeBulkEmail(INPUT);
    expect(sentHtml()).not.toContain("Payment Pending");
  });

  it("a group member is told the payer covers it", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ group: { billingAccount: { name: "Cleveland Clinic" } } })]);
    await executeBulkEmail(INPUT);
    const html = sentHtml();
    expect(html).toContain("Registration covered by Cleveland Clinic");
    expect(html).not.toContain("Pay Now");
  });
});
