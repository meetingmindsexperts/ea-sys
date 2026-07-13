/**
 * executeBulkEmail (bulk-email.ts) — certificate-send AUDIENCE scoping.
 *
 * The 2026-07-10 fix: the certificate bulk send targets ALL registrations
 * (check-in NOT required — the template tag is the only routing gate), but
 * never a CANCELLED one (mirrors the Issue-tab eligibility rule) unless an
 * explicit status filter already scopes the send. Also asserts the
 * skippedCount from the cert engine flows through the result.
 *
 * Heavy branches (rendering, cert issue, email send) are mocked — we assert
 * the registration `where` clause + result passthrough only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLoadCertTemplate, mockCertBulkSend } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockLoadCertTemplate: vi.fn(),
  mockCertBulkSend: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn(),
  getDefaultTemplate: vi.fn(),
  renderAndWrap: vi.fn(),
  brandingFrom: vi.fn(),
  brandingCc: vi.fn(),
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
vi.mock("@/lib/certificates/bundle", () => ({
  loadCertTemplate: (eventId: string, id: string) => mockLoadCertTemplate(eventId, id),
}));
vi.mock("@/lib/certificates/bulk-issue", () => ({
  executeCertificateBulkSend: (args: unknown) => mockCertBulkSend(args),
}));

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  slug: "osh",
  name: "OSH",
  startDate: new Date("2026-07-01"),
  venue: "Dubai",
  address: null,
  settings: {},
  emailFromAddress: null,
  emailFromName: null,
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

const REG_ROW = {
  id: "reg-1",
  serialId: 1,
  qrCode: "QR1",
  attendanceMode: "IN_PERSON",
  originalPrice: null,
  discountAmount: null,
  pricingTier: null,
  ticketType: { name: "Physician", price: 0, currency: "USD" },
  attendee: {
    email: "jane@x.com",
    additionalEmail: null,
    firstName: "Jane",
    lastName: "Doe",
    title: "DR",
  },
};

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "certificate" as const,
  filters: { certificateTemplateIds: ["tpl-1"] },
  organizerName: "Org Anizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

const CERT_RESULT = {
  total: 1,
  successCount: 1,
  failureCount: 0,
  skippedCount: 0,
  errors: [] as Array<{ email: string; error: string }>,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([REG_ROW]);
  mockLoadCertTemplate.mockResolvedValue({
    id: "tpl-1",
    name: "Attendance",
    category: "ATTENDANCE",
    autoIssueTag: "attended",
    template: { backgroundPdfUrl: null, textBoxes: [], role: null, cmeHours: null },
    emailSubject: null,
    emailBody: null,
  });
  mockCertBulkSend.mockResolvedValue(CERT_RESULT);
});

describe("executeBulkEmail — certificate audience scoping", () => {
  it("targets ALL non-cancelled registrations when no status filter is set (check-in NOT required)", async () => {
    await executeBulkEmail(BASE_INPUT);

    expect(mockDb.registration.findMany).toHaveBeenCalledTimes(1);
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    // No status equality filter — CONFIRMED, CHECKED_IN, PENDING all included…
    // …but CANCELLED is excluded (mirrors the Issue-tab eligibility rule).
    expect(where.status).toEqual({ not: "CANCELLED" });
  });

  it("respects an explicit status filter as-is (no extra CANCELLED guard)", async () => {
    await executeBulkEmail({
      ...BASE_INPUT,
      filters: { ...BASE_INPUT.filters, status: "CHECKED_IN" },
    });
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("CHECKED_IN");
  });

  it("REJECTS a certificate send that explicitly targets CANCELLED (M3)", async () => {
    // A cert must never be minted for a cancelled registration — the invariant
    // is unconditional, so an explicit CANCELLED filter is a 400, not a send.
    await expect(
      executeBulkEmail({
        ...BASE_INPUT,
        filters: { ...BASE_INPUT.filters, status: "CANCELLED" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
    // Rejected before resolving recipients.
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });

  it("passes the resolved recipients to the cert engine and returns its skippedCount", async () => {
    mockCertBulkSend.mockResolvedValue({
      total: 3,
      successCount: 1,
      failureCount: 0,
      skippedCount: 2,
      errors: [],
    });
    const res = await executeBulkEmail(BASE_INPUT);
    expect(mockCertBulkSend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-1",
        recipientType: "registrations",
        recipients: [expect.objectContaining({ id: "reg-1", email: "jane@x.com" })],
      }),
    );
    expect(res).toMatchObject({ successCount: 1, failureCount: 0, skippedCount: 2 });
  });

  it("excludes CANCELLED from a SURVEY invitation too (2026-07-13)", async () => {
    // The survey tile no longer pre-filters to CHECKED_IN: completing the
    // survey is what stamps `surveyCompletedAt`, which triggers certificate
    // auto-issue — so gating the invitation on check-in re-imposed, one step
    // upstream, the exact gate that was removed from certificates. Everyone
    // except CANCELLED now gets the invitation. (Cancelled stays out: the
    // auto-issue sweep refuses them, so the survey would dangle a certificate
    // they can never receive.)
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT,
      surveyConfig: [{ id: "q1", type: "rating", label: "How was it?" }],
    });
    // Aborts downstream (template loaders are mocked empty) — the `where`
    // clause is what this test pins.
    await executeBulkEmail({
      ...BASE_INPUT,
      emailType: "survey-invitation",
      filters: {},
    }).catch(() => null);

    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "CANCELLED" });
  });

  it("does NOT apply the CANCELLED guard to non-certificate email types", async () => {
    // A custom send with no status filter keeps the historical behavior
    // (no implicit status scoping). The mocked template loaders return
    // nothing so the send aborts AFTER recipient resolution — the where
    // clause is what this test pins.
    await executeBulkEmail({
      ...BASE_INPUT,
      emailType: "custom",
      customSubject: "S",
      customMessage: "<p>M</p>",
      filters: {},
    }).catch(() => null);
    expect(mockDb.registration.findMany).toHaveBeenCalledTimes(1);
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
  });
});
