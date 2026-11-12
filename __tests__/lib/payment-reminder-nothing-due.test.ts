/**
 * A payment reminder never reaches someone who owes nothing (owner, Nov 12,
 * 2026: "if someone is 0 or owes nothing, dont send any payment related
 * emails"). On the 4th GCC Hematology Hub five nurses entered a 100% code
 * after registering: payment status UNPAID, nothing due. The audience was
 * decided by the status alone, so a reminder would have asked them for 0.00.
 *
 * Runs the REAL bulk sender, the real balance helper and the real default
 * template, and asserts on who sendEmail is called for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockGetEventTemplate, mockLog } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLog }));
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

import { executeBulkEmail } from "@/lib/bulk-email";
import { getDefaultTemplate } from "@/lib/email";

const EVENT = {
  id: "evt-1", slug: "gcc-hh26", name: "4th GCC Hematology Hub 2026", organizationId: "org-1",
  startDate: new Date("2026-11-28"), endDate: new Date("2026-11-29"), timezone: "Asia/Dubai",
  venue: "Conrad", address: null, city: "Dubai", country: "UAE", settings: {},
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [],
  emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: null, surveyConfig: null,
  taxRate: 5, taxLabel: "VAT",
};

const NURSE = { name: "Nurse", price: 0, currency: "USD" };
const STANDARD = { name: "Standard", price: 200, currency: "USD" };

function reg(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, serialId: 1, qrCode: `QR-${id}`, attendanceMode: "IN_PERSON",
    originalPrice: 200, discountAmount: null, pricingTier: STANDARD, ticketType: NURSE,
    attendee: { email: `${id}@h.com`, additionalEmail: null, firstName: "Sara", lastName: id, title: "MS" },
    status: "CONFIRMED", paymentStatus: "UNPAID", payments: [], group: null,
    ...extra,
  };
}

const INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "payment-reminder" as const,
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
  filters: {},
};

const emailedTo = () => mockSendEmail.mock.calls.map((c) => (c[0] as { to: { email: string }[] }).to[0].email).sort();

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
  const def = getDefaultTemplate("payment-reminder")!;
  mockGetEventTemplate.mockResolvedValue({ ...def, branding: {} });
});

describe("bulk payment reminder: nobody who owes nothing", () => {
  it("chases the one who owes, and none of the ways of owing nothing", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      reg("owes"),
      // A 100% code entered after registering: UNPAID, nothing due.
      reg("code", { discountAmount: 200 }),
      // Paid in two parts while the status was never moved on.
      reg("parts", { payments: [{ amount: 110, status: "PAID" }, { amount: 100, status: "PAID" }] }),
      // A free type with no rate: nothing was ever priced.
      reg("free", { originalPrice: 0, pricingTier: null }),
      // Statuses a payment filter can name and the where clause lets through.
      reg("paid", { paymentStatus: "PAID", payments: [{ amount: 210, status: "PAID" }] }),
      reg("refunded", { paymentStatus: "REFUNDED" }),
    ]);
    const res = await executeBulkEmail(INPUT);
    expect(emailedTo()).toEqual(["owes@h.com"]);
    expect(res.successCount).toBe(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "bulk-email:payment-reminder-nothing-due-left-out",
        leftOut: 5,
        kept: 1,
        // Who, so "why was this person not reminded" can be answered from the log.
        registrationIds: ["code", "parts", "free", "paid", "refunded"],
      }),
    );
  });

  it("still chases someone who has paid only part", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("part", { payments: [{ amount: 100, status: "PAID" }] })]);
    await executeBulkEmail(INPUT);
    expect(emailedTo()).toEqual(["part@h.com"]);
  });

  it("a partial code leaves a balance, so the reminder goes", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("half", { discountAmount: 100 })]);
    await executeBulkEmail(INPUT);
    expect(emailedTo()).toEqual(["half@h.com"]);
  });

  it("refuses the send when everyone it found owes nothing", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("code", { discountAmount: 200 })]);
    await expect(executeBulkEmail(INPUT)).rejects.toMatchObject({ status: 400, code: "NO_RECIPIENTS" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("loads what the balance is worked out from", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("owes")]);
    await executeBulkEmail(INPUT);
    const select = mockDb.registration.findMany.mock.calls[0][0].select;
    expect(select.status).toBe(true);
    expect(select.payments).toEqual({ select: { amount: true, status: true } });
  });

  it("leaves every other send alone: an event reminder reaches a registration that owes nothing", async () => {
    const def = getDefaultTemplate("event-reminder")!;
    mockGetEventTemplate.mockResolvedValue({ ...def, branding: {} });
    mockDb.registration.findMany.mockResolvedValue([reg("code", { discountAmount: 200 })]);
    await executeBulkEmail({ ...INPUT, emailType: "reminder" as const });
    expect(emailedTo()).toEqual(["code@h.com"]);
  });
});
