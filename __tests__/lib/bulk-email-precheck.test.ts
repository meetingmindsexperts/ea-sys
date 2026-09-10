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
  mockDb: { event: { findFirst: vi.fn() }, rsvpCampaign: { findFirst: vi.fn() } },
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
  renderMessageValue: vi.fn((m: string) => m),
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

describe("precheckBulkEmailViability — unsupported email types (review A2, July 16 2026)", () => {
  // The three status-ASSERTING abstract types have no slug mapping and can
  // NEVER send: a type named "accepted" would tell a rejected author they
  // were accepted. Before this guard the routes returned 202 "queued" and the
  // row flipped FAILED a minute later. Rejected synchronously, BEFORE the
  // event load. (abstract-reminder left this list on Sep 8, 2026: it sends.)
  it.each(["abstract-accepted", "abstract-rejected", "abstract-revision"])(
    "rejects %s up-front with a 400 pointing at the abstract detail page",
    async (emailType) => {
      await expect(
        precheckBulkEmailViability({
          eventId: "evt-1",
          recipientType: "abstracts",
          emailType: emailType as never,
        }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("not supported") });
      // Rejected before any DB work.
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["abstract-confirmation", "abstract-decision", "abstract-reminder"])(
    "%s is slug-mapped and passes the guard (Sep 8, 2026)",
    async (emailType) => {
      const res = await precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "abstracts",
        emailType: emailType as never,
      });
      expect(res.event.id).toBe("evt-1");
    },
  );

  it("an explicit status that contradicts the abstract type is a 400, never a silent widen", async () => {
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "abstracts",
        emailType: "abstract-decision",
        filters: { status: "DRAFT" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "abstracts",
        emailType: "abstract-confirmation",
        filters: { status: "WITHDRAWN" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
    // A compatible explicit status passes.
    const ok = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "abstracts",
      emailType: "abstract-decision",
      filters: { status: "ACCEPTED" },
    });
    expect(ok.event.id).toBe("evt-1");
  });

  it("still allows every slug-mapped type through the guard", async () => {
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "reminder",
    });
    expect(res.event.id).toBe("evt-1");
  });
});

describe("precheckBulkEmailViability: {{rsvpLink}} campaign (Sep 10, 2026)", () => {
  it("returns the campaign when it belongs to the event and is open", async () => {
    mockDb.rsvpCampaign.findFirst.mockResolvedValue({ id: "camp-1", name: "Gala", isActive: true });
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "custom",
      customSubject: "s",
      customMessage: "m {{rsvpLink}}",
      filters: { rsvpCampaignId: "camp-1" },
    });
    expect(res.rsvpCampaign).toEqual({ id: "camp-1", name: "Gala" });
    // The lookup is EVENT-BOUND: a campaign id from another event misses.
    expect(mockDb.rsvpCampaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-1", eventId: "evt-1" } }),
    );
  });

  it("returns null when no campaign was chosen and never queries", async () => {
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "reminder",
    });
    expect(res.rsvpCampaign).toBeNull();
    expect(mockDb.rsvpCampaign.findFirst).not.toHaveBeenCalled();
  });

  it("a campaign that is not this event's is a 400 INVALID_FILTER", async () => {
    mockDb.rsvpCampaign.findFirst.mockResolvedValue(null);
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "reminder",
        filters: { rsvpCampaignId: "camp-other" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
  });

  it("a closed campaign is refused so nobody is mailed a link to a shut form", async () => {
    mockDb.rsvpCampaign.findFirst.mockResolvedValue({ id: "camp-1", name: "Gala", isActive: false });
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "speakers",
        emailType: "invitation",
        filters: { rsvpCampaignId: "camp-1" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER", message: expect.stringContaining("closed") });
  });

  it("only registrations and speakers can carry an RSVP link; reviewers are refused before any query", async () => {
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "reviewers",
        emailType: "custom",
        customSubject: "s",
        customMessage: "m",
        filters: { rsvpCampaignId: "camp-1" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
    expect(mockDb.rsvpCampaign.findFirst).not.toHaveBeenCalled();
  });
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
