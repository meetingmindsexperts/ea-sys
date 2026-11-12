/**
 * "Those who owe us" (owner, Nov 12, 2026): a recipient filter that goes by
 * the balance. "Filter recipients, Payment Status: UNPAID will not work to
 * chase unpaid registration because it would include those with promocode
 * 100%." The Chase Unpaid tile did exactly that with a Custom email.
 *
 * Runs the REAL bulk sender and the real balance helper for a Custom email,
 * and asserts on who sendEmail is called for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

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

import { bulkEmailSchema, executeBulkEmail } from "@/lib/bulk-email";
import { getDefaultTemplate } from "@/lib/email";
import { OWES_MONEY_FILTER, chasesBalance, excludedAsNoBalance, excludesCancelledByDefault, excludesGroupMembers } from "@/lib/bulk-email-audience";

const EVENT = {
  id: "evt-1", slug: "gcc-hh26", name: "4th GCC Hematology Hub 2026", organizationId: "org-1",
  startDate: new Date("2026-11-28"), endDate: new Date("2026-11-29"), timezone: "Asia/Dubai",
  venue: "Conrad", address: null, city: "Dubai", country: "UAE", settings: {},
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [],
  emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: null, surveyConfig: null,
  taxRate: 5, taxLabel: "VAT",
};
const STANDARD = { name: "Standard", price: 200, currency: "USD" };

function reg(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, serialId: 1, qrCode: `QR-${id}`, attendanceMode: "IN_PERSON",
    originalPrice: 200, discountAmount: null, pricingTier: STANDARD, ticketType: { name: "Physician", price: 0, currency: "USD" },
    attendee: { email: `${id}@h.com`, additionalEmail: null, firstName: "Sara", lastName: id, title: "MS" },
    status: "CONFIRMED", paymentStatus: "UNPAID", payments: [], group: null,
    ...extra,
  };
}

const CUSTOM = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "custom" as const,
  customSubject: "A note about your registration",
  customMessage: "<p>Please settle your registration fee.</p>",
  organizerName: "Organizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

const emailedTo = () => mockSendEmail.mock.calls.map((c) => (c[0] as { to: { email: string }[] }).to[0].email).sort();
const whereOf = () => mockDb.registration.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
  const def = getDefaultTemplate("custom-notification")!;
  mockGetEventTemplate.mockResolvedValue({ ...def, branding: {} });
});

describe("a Custom email to those who owe us", () => {
  const EVERY_WAY = [
    reg("owes"),
    reg("part", { payments: [{ amount: 100, status: "PAID" }] }),
    // A 100% code entered after registering: UNPAID, nothing due.
    reg("code", { discountAmount: 200 }),
    reg("free", { originalPrice: 0, pricingTier: null }),
    reg("paid", { paymentStatus: "PAID", payments: [{ amount: 210, status: "PAID" }] }),
  ];

  it("reaches only the people with a balance, whatever their payment status says", async () => {
    mockDb.registration.findMany.mockResolvedValue(EVERY_WAY);
    await executeBulkEmail({ ...CUSTOM, filters: { status: "CONFIRMED", owesMoney: true } });
    expect(emailedTo()).toEqual(["owes@h.com", "part@h.com"]);
  });

  it("without the filter, a Custom email to Unpaid still reaches a code holder: the status cannot tell them apart", async () => {
    mockDb.registration.findMany.mockResolvedValue(EVERY_WAY.slice(0, 4));
    await executeBulkEmail({ ...CUSTOM, filters: { status: "CONFIRMED", paymentStatus: "UNPAID" } });
    expect(emailedTo()).toContain("code@h.com");
    expect(emailedTo()).toContain("free@h.com");
  });

  it("asks the database for the same audience a payment reminder gets: no group member, no free status, no untyped row", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("owes")]);
    await executeBulkEmail({ ...CUSTOM, filters: { status: "CONFIRMED", owesMoney: true } });
    const where = whereOf();
    expect(where.groupId).toBeNull();
    expect(where.AND).toEqual([{ paymentStatus: { notIn: ["COMPLIMENTARY", "INCLUSIVE"] } }, { ticketTypeId: { not: null } }]);
    expect(where.status).toBe("CONFIRMED");
  });

  it("leaves out cancelled registrations when no status was chosen", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("owes")]);
    await executeBulkEmail({ ...CUSTOM, filters: { owesMoney: true } });
    expect(whereOf().status).toEqual({ not: "CANCELLED" });
  });

  it("refuses the send when nobody it found owes anything", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("code", { discountAmount: 200 })]);
    await expect(executeBulkEmail({ ...CUSTOM, filters: { owesMoney: true } })).rejects.toMatchObject({ status: 400, code: "NO_RECIPIENTS" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("is a filter the request schema keeps (an unknown key would be dropped and everyone mailed)", () => {
    const parsed = bulkEmailSchema.safeParse({ recipientType: "registrations", emailType: "custom", customSubject: "s", customMessage: "m", filters: { owesMoney: true } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.filters?.owesMoney).toBe(true);
  });
});

describe("the one rule the counts and the send share", () => {
  it("applies to a payment reminder always, and to any other send only with the filter", () => {
    expect(chasesBalance("payment-reminder")).toBe(true);
    expect(chasesBalance("custom")).toBe(false);
    expect(chasesBalance("custom", true)).toBe(true);
    expect(excludesGroupMembers("custom")).toBe(false);
    expect(excludesGroupMembers("custom", true)).toBe(true);
  });

  it("leaves out whoever owes nothing, for a Custom email with the filter", () => {
    expect(excludedAsNoBalance("custom", "UNPAID", true, 0, true)).toBe(true);
    expect(excludedAsNoBalance("custom", "UNPAID", true, 210, true)).toBe(false);
    expect(excludedAsNoBalance("custom", "COMPLIMENTARY", true, 210, true)).toBe(true);
    expect(excludedAsNoBalance("custom", "UNPAID", false, 210, true)).toBe(true);
    // And leaves a Custom email with no such filter alone.
    expect(excludedAsNoBalance("custom", "UNPAID", true, 0)).toBe(false);
  });

  it("reads Paid and Refunded as owing nothing when the balance cannot be seen", () => {
    for (const status of ["PAID", "REFUNDED"]) expect(excludedAsNoBalance("custom", status, true, null, true)).toBe(true);
    for (const status of ["UNPAID", "PENDING", "FAILED", "UNASSIGNED"]) expect(excludedAsNoBalance("custom", status, true, null, true)).toBe(false);
  });

  it("drops cancelled registrations unless a status was chosen", () => {
    expect(excludesCancelledByDefault("custom", undefined, true)).toBe(true);
    expect(excludesCancelledByDefault("custom", "all", true)).toBe(true);
    expect(excludesCancelledByDefault("custom", "CONFIRMED", true)).toBe(false);
    expect(excludesCancelledByDefault("custom", undefined)).toBe(false);
  });
});

describe("where the organiser meets it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the dialog offers it in the payment picker and sends it as owesMoney, never as a payment status", () => {
    const src = read("src/components/bulk-email-dialog.tsx");
    expect(src).toContain("<SelectItem value={OWES_MONEY_FILTER}>{OWES_MONEY_LABEL}</SelectItem>");
    expect(src).toContain('localPaymentFilter === OWES_MONEY_FILTER ? { owesMoney: true } : {}');
    expect(src).toContain('localPaymentFilter !== "all" && localPaymentFilter !== OWES_MONEY_FILTER');
  });

  it("the Chase Unpaid tile uses it, for its count and its send", () => {
    const src = read("src/app/(dashboard)/events/[eventId]/communications/page.tsx");
    const tile = src.slice(src.indexOf('id: "chase-unpaid"'), src.indexOf('id: "welcome-paid"'));
    expect(tile).toContain("paymentStatus: OWES_MONEY_FILTER");
    expect(tile).toContain("excludedAsNoBalance(");
    expect(tile).not.toContain('paymentStatus: "UNPAID"');
    expect(tile).not.toContain('r.paymentStatus === "UNPAID"');
  });

  it("both pages count with the filter the dialog sends", () => {
    for (const page of ["src/app/(dashboard)/events/[eventId]/communications/page.tsx", "src/app/(dashboard)/events/[eventId]/registrations/page.tsx"]) {
      const src = read(page);
      expect(src).toContain("r.rowMoney?.amountDue ?? null, f.owesMoney)");
      expect(src).toContain("excludesGroupMembers(f.emailType, f.owesMoney)");
      expect(src).toContain("excludesCancelledByDefault(f.emailType, f.status, f.owesMoney)");
    }
    expect(OWES_MONEY_FILTER).not.toMatch(/^[A-Z_]+$/);
  });
});
