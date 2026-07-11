/**
 * precheckBulkEmailViability (bulk-email.ts) — the shared config-viability gate
 * (review M2). The enqueue + schedule routes call it synchronously so a
 * misconfigured send is rejected with a real 4xx NOW instead of a green
 * "queued" toast followed by a FAILED ScheduledEmail row a minute later.
 * executeBulkEmail calls the SAME function at fire time as the backstop, so the
 * two can't drift.
 *
 * Heavy collaborators (cert template load, agreement-mode pick, event load) are
 * mocked — we assert the throw/return contract only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLoadCertTemplate, mockPickAgreementMode } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockLoadCertTemplate: vi.fn(),
  mockPickAgreementMode: vi.fn(),
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
  pickAgreementAttachmentMode: (args: unknown) => mockPickAgreementMode(args),
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
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

import { precheckBulkEmailViability, BulkEmailError } from "@/lib/bulk-email";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockPickAgreementMode.mockReturnValue(null);
});

describe("precheckBulkEmailViability", () => {
  it("returns event + nulls for a valid custom send", async () => {
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "custom",
      customSubject: "S",
      customMessage: "M",
    });
    expect(res.event.id).toBe("evt-1");
    expect(res.certTemplates).toBeNull();
    expect(res.agreementMode).toBeNull();
  });

  it("throws 404 when the event does not exist", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    await expect(
      precheckBulkEmailViability({
        eventId: "gone",
        recipientType: "registrations",
        emailType: "reminder",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 for a custom send missing subject/message", async () => {
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "custom",
        customSubject: "only subject",
      }),
    ).rejects.toBeInstanceOf(BulkEmailError);
    // Never reaches the event load.
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("throws 400 for a survey invitation to non-registrations", async () => {
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "speakers",
        emailType: "survey-invitation",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when a certificate template has no tag", async () => {
    mockLoadCertTemplate.mockResolvedValue({
      id: "tpl-1",
      name: "Attendance",
      category: "ATTENDANCE",
      autoIssueTag: "  ", // whitespace-only ⇒ untagged
      template: {},
    });
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "certificate",
        filters: { certificateTemplateIds: ["tpl-1"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns loaded certTemplates for a tagged certificate send", async () => {
    mockLoadCertTemplate.mockResolvedValue({
      id: "tpl-1",
      name: "Attendance",
      category: "ATTENDANCE",
      autoIssueTag: "attended",
      template: {},
    });
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "certificate",
      filters: { certificateTemplateIds: ["tpl-1"] },
    });
    expect(res.certTemplates).toHaveLength(1);
  });

  it("throws 400 when a certificate template no longer exists", async () => {
    mockLoadCertTemplate.mockResolvedValue(null);
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "certificate",
        filters: { certificateTemplateIds: ["gone"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 for an agreement send with no docx/HTML template", async () => {
    mockPickAgreementMode.mockReturnValue(null);
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "speakers",
        emailType: "agreement",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns agreementMode for an agreement send with a template", async () => {
    mockPickAgreementMode.mockReturnValue("docx");
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "speakers",
      emailType: "agreement",
    });
    expect(res.agreementMode).toBe("docx");
  });

  it("throws 400 for a survey invitation when no survey is configured", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, surveyConfig: [] });
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "survey-invitation",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
