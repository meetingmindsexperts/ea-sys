/**
 * The survey thank-you fills the registration details a saved template uses.
 *
 * Production case (Sep 17, 2026, OOPVF2026): the event's saved Survey Thank
 * You template greets "Dear {{title}} {{lastName}}", but the sender filled only
 * firstName (and a blank lastName), so sendEmail refused the email for the
 * unresolved {{title}} on every 3-minute tick. This runs the REAL renderer over
 * that greeting and asserts on what sendEmail receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockDbOperator, mockSendEmail, mockGetEventTemplate, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findFirst: vi.fn().mockResolvedValue(null) },
    issuedCertificate: { findMany: vi.fn().mockResolvedValue([]) },
    certificateIssueRunItem: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  },
  mockDbOperator: {
    registration: { findMany: vi.fn() },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/certificates/pdf-loader", () => ({ loadCertificatePdfBytes: vi.fn() }));
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
  attendee: { title: "DR", firstName: "Sara", lastName: "Al Harthy", email: "sara@hospital.com" },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDbOperator.registration.findMany.mockResolvedValue([CANDIDATE]);
  mockDbOperator.emailLog.findMany.mockResolvedValue([]);
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
