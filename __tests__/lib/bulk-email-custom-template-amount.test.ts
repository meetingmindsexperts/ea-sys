/**
 * executeBulkEmail, a saved (custom) template sent to registrations fills
 * {{amount}} and {{paymentBlock}} as the payment reminder does (Nov 27, 2026:
 * a copy of the reminder on GCC Hematology Hub was refused on {{amount}} for
 * every recipient). Someone who owes nothing gets both blank.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockGetEventTemplate, mockLoadRow } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockLoadRow: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
    loadActiveEventTemplateRow: (...args: unknown[]) => mockLoadRow(...args),
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

import { executeBulkEmail } from "@/lib/bulk-email";
import { templateAllowedTokenKeys } from "@/lib/email-template-registry";

const EVENT = {
  id: "evt-1", slug: "gcc-hh26", name: "4th GCC Hematology Hub 2026",
  startDate: new Date("2026-12-10"), endDate: new Date("2026-12-11"), timezone: "Asia/Dubai",
  venue: "Venue", address: null, city: "Dubai", country: "UAE", settings: {},
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [],
  emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: null, surveyConfig: null,
  taxRate: null, taxLabel: null,
};

const TEMPLATE = {
  slug: "payment-reminder-discount",
  subject: "Enjoy 30% Off",
  htmlContent: "<p>Dear {{firstName}}, you owe {{amount}}.</p>{{paymentBlock}}",
  textContent: "Dear {{firstName}}, you owe {{amount}}.",
};

function reg(extra: Record<string, unknown>) {
  return {
    id: "reg-1", serialId: 3, qrCode: "QR1", attendanceMode: "IN_PERSON",
    originalPrice: 100, discountAmount: null, pricingTier: null,
    ticketType: { name: "Delegate", price: 100, currency: "USD" },
    attendee: { email: "d@h.com", additionalEmail: null, firstName: "Sara", lastName: "Al Harthy", title: "DR" },
    paymentStatus: "UNPAID", group: null, createdSource: null, status: "CONFIRMED", payments: [],
    ...extra,
  };
}

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "template" as const,
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
  filters: { templateSlug: "payment-reminder-discount" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
  mockLoadRow.mockResolvedValue({ ...TEMPLATE, id: "tpl-1", isActive: true });
  mockGetEventTemplate.mockResolvedValue({ ...TEMPLATE, branding: {} });
});

function sentHtml(): string {
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  return (mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent;
}

describe("a saved template sent to registrations: {{amount}} and {{paymentBlock}}", () => {
  it("someone who owes gets the amount and a Pay Now link", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({})]);
    const res = await executeBulkEmail(INPUT);
    expect(res.successCount).toBe(1);
    const html = sentHtml();
    expect(html).toContain("you owe USD 100.00");
    expect(html).toContain("/e/gcc-hh26/confirmation?id=reg-1");
    expect(html).not.toContain("{{amount}}");
  });

  it("someone who owes nothing gets neither a price nor Pay Now", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ paymentStatus: "PAID" })]);
    await executeBulkEmail(INPUT);
    const html = sentHtml();
    expect(html).not.toContain("USD 100.00");
    expect(html).not.toContain("Pay Now");
    expect(html).not.toContain("{{amount}}");
  });

  it("the template editor does not warn that {{amount}} cannot be filled", () => {
    expect(templateAllowedTokenKeys("payment-reminder-discount")).toContain("amount");
  });
});
