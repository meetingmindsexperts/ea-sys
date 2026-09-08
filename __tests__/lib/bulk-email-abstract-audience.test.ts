/**
 * executeBulkEmail: the abstract email types (Sep 8, 2026).
 *
 * The July-16 review removed the abstract types because the pipeline could
 * not build per-abstract context; organisers were then left with no way to
 * resend an abstract email in bulk. These pin the shape that makes them
 * correct: one email PER ABSTRACT for confirmation and decision (an author
 * with two abstracts gets two), the decision rendered from each abstract's
 * CURRENT status with its reviewer notes, the type's default status scope,
 * and the EmailLog row landing on the SPEAKER.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendEmail } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail,
    getEventTemplate: vi.fn().mockResolvedValue(null),
    getDefaultTemplate: vi.fn((slug: string) => ({ slug, subject: `S:${slug}`, htmlContent: "<p>x</p>", textContent: "x" })),
    renderMessageValue: vi.fn((m: string) => m),
    // Echo the vars so each assertion can read exactly what the email saw.
    renderAndWrap: vi.fn((tpl: { subject: string }, vars: Record<string, unknown>) => ({
      subject: tpl.subject,
      htmlContent: JSON.stringify(vars),
      textContent: "",
    })),
    brandingFrom: vi.fn(),
    brandingCc: vi.fn(),
  };
});
vi.mock("@/lib/speaker-agreement", () => ({
  buildSpeakerEmailContext: vi.fn(),
  generateSpeakerAgreementDocx: vi.fn(),
  generateSpeakerAgreementPdf: vi.fn(),
  pickAgreementAttachmentMode: vi.fn(),
  templateUsesAgreementAttachment: vi.fn().mockReturnValue(false),
  SPEAKER_AGREEMENT_DOCX_MIME: "application/vnd.docx",
  SPEAKER_AGREEMENT_PDF_MIME: "application/pdf",
}));
vi.mock("@/lib/email-barcode", () => ({ buildEntryBarcode: vi.fn(), templateUsesEntryBarcode: vi.fn().mockReturnValue(false) }));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/email-attachments", () => ({ resolveStoredAttachments: vi.fn().mockResolvedValue({ ok: true, attachments: [] }) }));

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1", slug: "hemnet", name: "HEMNET 2026", startDate: new Date("2026-07-01"), venue: "Dubai", address: null,
  settings: {}, emailFromAddress: null, emailFromName: null, emailCcAddresses: null, emailHeaderImage: null,
  emailFooterImage: null, emailFooterHtml: null, speakerAgreementTemplate: null, speakerAgreementHtml: null,
  surveyConfig: null, taxRate: null, taxLabel: null, timezone: "Asia/Dubai",
};
const SPEAKER = { id: "spk-1", email: "jane@x.com", additionalEmail: null, firstName: "Jane", lastName: "Doe", title: "DR" };
const abstractRow = (over: Record<string, unknown>) => ({
  id: "abs-1", title: "Iron in HF", serialId: 7, presentationType: "ORAL", coAuthors: null, status: "SUBMITTED",
  theme: { name: "Cardiology" }, submissions: [], speaker: SPEAKER, ...over,
});
const BASE = { eventId: "evt-1", recipientType: "abstracts" as const, organizerName: "Org", organizerEmail: "org@x.com", organizationId: "org-1", triggeredByUserId: "u1" };
const sentVars = (i = 0) => JSON.parse(sendEmail.mock.calls[i][0].htmlContent) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
});

describe("abstract-confirmation", () => {
  it("sends ONE email per abstract (two abstracts by one author = two emails), each with its own number and title", async () => {
    mockDb.abstract.findMany.mockResolvedValue([
      abstractRow({ id: "abs-1", serialId: 7, title: "Iron in HF" }),
      abstractRow({ id: "abs-2", serialId: 9, title: "Anaemia audit" }),
    ]);
    const r = await executeBulkEmail({ ...BASE, emailType: "abstract-confirmation" });
    expect(r.successCount).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sentVars(0)).toMatchObject({ abstractNumber: "A-007", abstractTitle: "Iron in HF", theme: "Cardiology", presentationType: "Oral", travelGrantBlock: "" });
    expect(sentVars(1)).toMatchObject({ abstractNumber: "A-009", abstractTitle: "Anaemia audit" });
    expect(sentVars(0).managementLink).toContain("/e/hemnet/");
    // Default scope: never a draft or a withdrawal.
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toMatchObject({ status: { notIn: ["DRAFT", "WITHDRAWN"] } });
    // The Email History row lands on the SPEAKER, like the single resend.
    expect(sendEmail.mock.calls[0][0].logContext).toMatchObject({ entityType: "SPEAKER", entityId: "spk-1" });
  });
});

describe("abstract-decision", () => {
  it("renders each abstract's CURRENT status with its consolidated reviewer notes, decided abstracts only", async () => {
    mockDb.abstract.findMany.mockResolvedValue([
      abstractRow({ id: "abs-1", status: "ACCEPTED", submissions: [{ reviewNotes: "Strong <b>data</b>", overallScore: 80 }, { reviewNotes: null, overallScore: 90 }] }),
      abstractRow({ id: "abs-2", status: "REJECTED", submissions: [] }),
    ]);
    const r = await executeBulkEmail({ ...BASE, emailType: "abstract-decision" });
    expect(r.successCount).toBe(2);
    expect(sentVars(0)).toMatchObject({ statusHeading: "Abstract Accepted!", newStatus: "ACCEPTED", reviewScore: 85 });
    expect(String(sentVars(0).reviewNotes)).toContain("Reviewer Notes");
    expect(String(sentVars(0).reviewNotes)).toContain("Strong &lt;b&gt;data&lt;/b&gt;"); // author-visible free text, escaped
    expect(sentVars(1)).toMatchObject({ statusHeading: "Abstract Decision", newStatus: "REJECTED", reviewNotes: "" });
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toMatchObject({ status: { in: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"] } });
  });
});

describe("abstract-reminder and custom", () => {
  it("a reminder goes once per author (not per abstract) and defaults to DRAFT", async () => {
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1", status: "DRAFT" }), abstractRow({ id: "abs-2", status: "DRAFT" })]);
    const r = await executeBulkEmail({ ...BASE, emailType: "abstract-reminder", customMessage: "Deadline is Friday" });
    expect(r.successCount).toBe(1);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toMatchObject({ status: "DRAFT" });
    expect(sentVars(0)).toMatchObject({ message: "Deadline is Friday" });
    expect(sentVars(0).managementLink).toContain("/e/hemnet/");
  });

  it("a custom email keeps the per-author dedup and no status scope", async () => {
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1" }), abstractRow({ id: "abs-2" })]);
    const r = await executeBulkEmail({ ...BASE, emailType: "custom", customSubject: "Hi", customMessage: "There" });
    expect(r.successCount).toBe(1);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).not.toHaveProperty("status");
  });
});
