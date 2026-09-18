/**
 * Sender-to-template drift, the bulk pipeline: for EVERY (email type,
 * audience) the template registry declares, run executeBulkEmail with one
 * recipient against the real DEFAULT template through the real renderer, and
 * assert the email sendEmail receives carries no unresolved {{token}}.
 *
 * This is the test that was missing on September 18, 2026: five maps agreed
 * that "confirmation" existed for registrations, none knew the template
 * needed {{paymentBlock}}, and the bulk Registration Confirmation was refused
 * for every recipient on most events. The cases come from the registry, so a
 * template that gains a bulk type is covered the day it is added, and a token
 * added to a default body without a sender filling it fails here, not in an
 * organizer's inbox.
 *
 * Everything below the pipeline is real except the wire (sendEmail), the
 * database, and the heavy builders that need one (speaker context, agreement
 * PDF, barcode, travel-grant, certificates), which answer with fixed values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    registration: { findMany: vi.fn() },
    speaker: { findMany: vi.fn() },
    abstract: { findMany: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockSendEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: (...args: unknown[]) => mockSendEmail(...args) };
});
vi.mock("@/lib/speaker-agreement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speaker-agreement")>();
  return {
    ...actual,
    buildSpeakerEmailContext: vi.fn().mockResolvedValue({
      title: "Dr.",
      speakerName: "Dr. Aisha Khan",
      presentationDetails: "<table><tr><td>Session</td><td>Opening Keynote</td></tr></table>",
      presentationDetailsText: "Session: Opening Keynote",
      moderatorDetails: "",
      moderatorDetailsText: "",
      sessionTitles: "Opening Keynote",
      honorarium: "0.00",
      honorariumAmount: "0.00",
      honorariumCurrency: "",
    }),
    generateSpeakerAgreementDocx: vi.fn().mockResolvedValue(null),
    generateSpeakerAgreementPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 stub")),
    mintSpeakerAgreementLink: vi.fn().mockResolvedValue("https://x.test/agree/abc"),
  };
});
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn().mockResolvedValue({ html: "<img alt=\"barcode\">", text: "QR1-003" }),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({
  buildPaymentReminderVars: vi.fn().mockReturnValue({ amount: "USD 105.00", paymentBlock: "<div>Pay now</div>" }),
}));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));
vi.mock("@/lib/email-attachments", () => ({ resolveStoredAttachments: vi.fn().mockResolvedValue({ ok: true, attachments: [] }) }));
vi.mock("@/lib/travel-grant/server", () => ({
  resolveTravelGrantBlock: vi.fn().mockResolvedValue({ html: "<p>grant</p>", text: "grant" }),
}));

import { executeBulkEmail } from "@/lib/bulk-email";
import { findUnresolvedTokens } from "@/lib/template-tokens";
import { EMAIL_TEMPLATE_SPECS, type BulkEmailAudience } from "@/lib/email-template-registry";

const EVENT = {
  id: "evt-1", slug: "osh", name: "OSH Monthly Meeting 2026",
  startDate: new Date("2026-10-02T05:00:00Z"), endDate: new Date("2026-10-03T14:00:00Z"), timezone: "Asia/Dubai",
  venue: "Raffles", address: "Wafi", city: "Dubai", country: "UAE",
  settings: { webinar: { sessionId: "sess-1" }, reviewerUserIds: ["rev-1"] },
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [],
  emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: "<p>Agreement text</p>",
  surveyConfig: [{ id: "q1", type: "rating_1_to_5", label: "Overall", required: true }],
  taxRate: 5, taxLabel: "VAT",
};

const REGISTRATION = {
  id: "reg-1", serialId: 3, qrCode: "QR1", attendanceMode: "IN_PERSON",
  originalPrice: 100, discountAmount: null, pricingTier: null,
  ticketType: { name: "Delegate", price: 100, currency: "USD" },
  attendee: { email: "d@h.test", additionalEmail: null, firstName: "Sara", lastName: "Al Harthy", title: "DR" },
  paymentStatus: "UNPAID", group: null,
};

const SPEAKER = {
  id: "spk-1", email: "dr@x.test", additionalEmail: null, firstName: "Aisha", lastName: "Khan", title: "DR",
  agreementAcceptedAt: null,
};

function abstractRow(status: string) {
  return {
    id: "abs-1", title: "Sodium in heart failure", serialId: 7, presentationType: "ORAL", coAuthors: [], status,
    theme: { name: "Cardiology" },
    submissions: [{ reviewNotes: "Strong methods", overallScore: 82 }],
    speaker: { id: "spk-1", email: "dr@x.test", additionalEmail: null, firstName: "Aisha", lastName: "Khan", title: "DR", country: "Jordan" },
  };
}

const REVIEWER = { id: "rev-1", email: "rev@x.test", firstName: "Omar", lastName: "Haddad" };

/** The abstract status the type's default scope selects (the where is mocked, the row must fit it). */
const ABSTRACT_STATUS_FOR_TYPE: Record<string, string> = {
  "abstract-confirmation": "SUBMITTED",
  "abstract-decision": "ACCEPTED",
  "abstract-reminder": "DRAFT",
};

beforeEach(() => {
  vi.clearAllMocks();
  // The survey-invitation case mints a real token, and hashVerificationToken
  // peppers it with NEXTAUTH_SECRET. Locally that is always set, because the
  // Prisma client loads .env into process.env on import and bulk-email.ts
  // imports its enums; the CI runner has no .env, so without this line the
  // per-recipient mint throws and the case reads as a failed send (the Sep 17
  // invitation test needed the same line).
  process.env.NEXTAUTH_SECRET = "test-secret-email-drift";
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.emailTemplate.findUnique.mockResolvedValue(null);
  mockDb.registration.findMany.mockResolvedValue([REGISTRATION]);
  mockDb.speaker.findMany.mockResolvedValue([SPEAKER]);
  mockDb.user.findMany.mockResolvedValue([REVIEWER]);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.emailLog.findMany.mockResolvedValue([]);
  mockDb.eventSession.findFirst.mockResolvedValue({ startTime: new Date("2026-10-02T06:00:00Z"), endTime: new Date("2026-10-02T07:00:00Z") });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ joinUrl: "https://zoom.test/j/1", passcode: "123456", recordingStatus: "AVAILABLE", recordingUrl: "https://zoom.test/rec/1" });
  mockSendEmail.mockResolvedValue({ success: true, messageId: "m1" });
});

/** Every (type, audience) the registry says the bulk pipeline sends. The webinar sequence has no dropdown entry; it goes to registrations. */
const CASES: Array<{ slug: string; type: string; audience: BulkEmailAudience }> = [];
for (const t of EMAIL_TEMPLATE_SPECS) {
  if (!t.bulk) continue;
  const audiences = t.bulk.audiences.length > 0 ? t.bulk.audiences.map((a) => a.audience) : (["registrations"] as const);
  for (const audience of audiences) CASES.push({ slug: t.slug, type: t.bulk.type, audience });
}

describe("bulk pipeline: every registered (type, audience) renders its default template with nothing unresolved", () => {
  it("covers the fifteen bulk types the registry declares", () => {
    expect(new Set(CASES.map((c) => c.type)).size).toBe(15);
  });

  it.each(CASES)("$type → $audience ($slug)", async ({ type, audience }) => {
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow(ABSTRACT_STATUS_FOR_TYPE[type] ?? "SUBMITTED")]);

    const res = await executeBulkEmail({
      eventId: "evt-1",
      recipientType: audience,
      emailType: type as never,
      filters: {},
      organizerName: "Organizer",
      organizerEmail: "org@x.test",
      organizationId: "org-1",
      triggeredByUserId: "user-1",
      // Only the custom type needs these; harmless for the rest.
      customSubject: "A note for {{firstName}}",
      customMessage: "Please read this.",
    });

    expect(res.failureCount, `${type}/${audience}: ${JSON.stringify(res.errors)}`).toBe(0);
    expect(mockSendEmail).toHaveBeenCalled();
    for (const call of mockSendEmail.mock.calls) {
      const params = call[0] as { subject: string; htmlContent: string; textContent?: string };
      expect(findUnresolvedTokens(params.subject, params.htmlContent), `${type}/${audience}: unresolved in subject or body`).toEqual([]);
      expect(findUnresolvedTokens(params.textContent), `${type}/${audience}: unresolved in the text part`).toEqual([]);
    }
  });
});
