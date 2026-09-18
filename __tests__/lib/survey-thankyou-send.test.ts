/**
 * The survey thank-you fills the registration details a saved template uses,
 * carries the certificates the person has not yet received, and CCs their
 * additional email.
 *
 * Production case (Sep 17, 2026, OOPVF2026): the event's saved Survey Thank
 * You template greets "Dear {{title}} {{lastName}}", but the sender filled only
 * firstName (and a blank lastName), so sendEmail refused the email for the
 * unresolved {{title}} on every 3-minute tick. This runs the REAL renderer over
 * that greeting and asserts on what sendEmail receives.
 *
 * Second case (Sep 18, 2026, same event): an organizer issued the CME
 * certificate from the registration page with "Send email" unticked, the
 * person then answered the survey, and the thank-you (whose wording promised
 * an attachment) went out with nothing attached, because it carried only
 * survey-issued certificates. The rule is now "everything the person holds
 * that has never gone out in a sent email"; see selectCertsToAttach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockDbOperator, mockSendEmail, mockGetEventTemplate, mockLoadPdf, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findFirst: vi.fn().mockResolvedValue(null) },
    issuedCertificate: { findMany: vi.fn().mockResolvedValue([]) },
    certificateIssueRunItem: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    certificateIssueRun: { update: vi.fn().mockResolvedValue({}) },
    // The delivery marker: SENT rows carrying "<serial>.pdf".
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockDbOperator: {
    registration: { findMany: vi.fn() },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockLoadPdf: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: (url: string, ctx: unknown) => mockLoadPdf(url, ctx),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
  };
});

import { runSurveyThankYouSweep } from "@/lib/certificates/survey-thankyou-sweep";
import { UNRESOLVED_TOKENS_CODE } from "@/lib/template-tokens";

const CANDIDATE = {
  id: "reg-000000001",
  eventId: "evt-1",
  // Past the 15-minute fallback, and resolved, so the sweep sends now.
  surveyCompletedAt: new Date(Date.now() - 20 * 60 * 1000),
  certAutoIssueCheckedAt: new Date(),
  serialId: 1,
  attendee: {
    title: "DR",
    firstName: "Sara",
    lastName: "Al Harthy",
    email: "sara@hospital.com",
    additionalEmail: "sara.office@hospital.com",
  },
  ticketType: { name: "Delegate" },
  event: {
    name: "Oman Oncology Pharmacy Value Forum 2026",
    organizationId: "org-1",
    emailHeaderImage: null,
    emailFooterImage: null,
    emailFooterHtml: null,
    emailFromAddress: null,
    emailFromName: null,
    emailCcAddresses: [],
  },
};

/** A CME certificate issued from the registration page: no run item at all. */
const MANUAL_CERT = {
  id: "cert-1",
  serial: "OOPVF2026-ATT-0001",
  pdfUrl: "/uploads/certificates/evt-1/2026/09/OOPVF2026-ATT-0001.pdf",
  deliveredViaItem: null,
  issueRunItem: null,
};

function sentArgs() {
  return mockSendEmail.mock.calls[0][0] as {
    cc?: { email: string }[];
    attachments?: { name: string; contentType: string }[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbOperator.registration.findMany.mockResolvedValue([CANDIDATE]);
  mockDbOperator.emailLog.findMany.mockResolvedValue([]);
  mockDb.issuedCertificate.findMany.mockResolvedValue([]);
  mockDb.emailLog.findMany.mockResolvedValue([]);
  mockDb.certificateIssueRunItem.count.mockResolvedValue(0);
  mockDb.certificateIssueRunItem.findMany.mockResolvedValue([]);
  mockLoadPdf.mockResolvedValue(Buffer.from("%PDF-1.7 certificate"));
  mockGetEventTemplate.mockResolvedValue({
    subject: "Thank you for your feedback | {{eventName}}",
    htmlContent: "<p>Dear {{title}} {{lastName}},</p><p>Thank you for completing the {{eventName}} survey. Registration #{{registrationId}} ({{ticketType}}).</p>",
    textContent: "Dear {{title}} {{lastName}}",
    branding: {},
  });
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
});

describe("survey thank-you send", () => {
  it("fills title, last name and the registration details the saved template uses", async () => {
    const result = await runSurveyThankYouSweep();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const html = (mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent;
    expect(html).toContain("Dear Dr. Al Harthy,");
    expect(html).toContain("Registration #001 (Delegate)");
    expect(html).not.toMatch(/\{\{/);
    expect(result).toMatchObject({ sent: 1, plain: 1 });
  });

  it("CCs the person's additional email, like every other attendee email (Sep 18, 2026)", async () => {
    await runSurveyThankYouSweep();
    expect(sentArgs().cc).toEqual([{ email: "sara.office@hospital.com" }]);
  });

  it("says a missing-variable refusal will not be retried, and does not count it as sent", async () => {
    mockSendEmail.mockResolvedValue({
      success: false,
      code: UNRESOLVED_TOKENS_CODE,
      error: "The email still contains {{colour}}",
    });

    const result = await runSurveyThankYouSweep();

    expect(result.sent).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "survey-thankyou:template-variable-unfilled-not-retried", registrationId: CANDIDATE.id }),
    );
  });
});

describe("what the thank-you carries (Sep 18, 2026)", () => {
  it("attaches a certificate issued from the registration page that was never emailed", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([MANUAL_CERT]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ sent: 1, withCert: 1, plain: 0 });
    expect(sentArgs().attachments).toEqual([
      expect.objectContaining({ name: "OOPVF2026-ATT-0001.pdf", contentType: "application/pdf" }),
    ]);
    expect(mockLoadPdf).toHaveBeenCalledWith(MANUAL_CERT.pdfUrl, expect.objectContaining({ certificateId: "cert-1" }));
    // The delivery marker is the sent-email record carrying the PDF's name.
    expect(mockDb.emailLog.findMany).toHaveBeenCalledWith({
      where: { eventId: "evt-1", status: "SENT", attachmentNames: { hasSome: ["OOPVF2026-ATT-0001.pdf"] } },
      select: { attachmentNames: true },
    });
  });

  it("does not attach a certificate that already went out in a sent email", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([MANUAL_CERT]);
    mockDb.emailLog.findMany.mockResolvedValue([{ attachmentNames: ["OOPVF2026-ATT-0001.pdf"] }]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ sent: 1, withCert: 0, plain: 1 });
    expect(sentArgs().attachments).toBeUndefined();
    expect(mockLoadPdf).not.toHaveBeenCalled();
  });

  it("leaves a certificate from a manual Issue run to that run, whatever its state", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([
      { ...MANUAL_CERT, deliveredViaItem: { emailedAt: null, run: { autoIssue: false } } },
    ]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ sent: 1, withCert: 0, plain: 1 });
    expect(mockDb.emailLog.findMany).not.toHaveBeenCalled();
  });

  it("does not attach a survey-issued certificate whose cover email already went", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([
      { ...MANUAL_CERT, deliveredViaItem: { emailedAt: new Date(), run: { autoIssue: true } } },
    ]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ sent: 1, withCert: 0, plain: 1 });
  });

  it("attaches a survey-issued certificate whose cover email is still pending, and suppresses that cover", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([
      { ...MANUAL_CERT, deliveredViaItem: { emailedAt: null, run: { autoIssue: true } } },
    ]);
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([{ id: "item-1", runId: "run-1" }]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ sent: 1, withCert: 1 });
    expect(mockDb.certificateIssueRunItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "item-1" }, data: { emailedAt: expect.any(Date) } }),
    );
    expect(mockDb.certificateIssueRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-1" }, data: { emailedCount: { increment: 1 } } }),
    );
  });

  it("recognises a pre-bundle certificate through its legacy run-item link", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([
      { ...MANUAL_CERT, issueRunItem: { emailedAt: new Date(), run: { autoIssue: true } } },
    ]);

    const result = await runSurveyThankYouSweep();

    expect(result).toMatchObject({ withCert: 0, plain: 1 });
  });

  it("only considers rendered, unrevoked certificates", async () => {
    await runSurveyThankYouSweep();
    expect(mockDb.issuedCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "evt-1", revokedAt: null, pdfUrl: { not: null } }),
      }),
    );
  });
});
