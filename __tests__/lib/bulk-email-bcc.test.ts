/**
 * executeBulkEmail — BCC observers + "send a copy to me" (organizer request
 * July 29, 2026, CRM-email-dialog parity).
 *
 * Both ride inside `filters` (the surveyExpiryDays pattern) so scheduled
 * sends reconstruct them from the persisted ScheduledEmail.filters JSON with
 * no new column; `bccSelf` resolves to the ORGANIZER at send time. A
 * recipient is never BCC'd on their own email.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockRenderAndWrap, mockGetDefaultTemplate, mockGetEventTemplate, mockBuildSpeakerEmailContext } =
  vi.hoisted(() => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn() },
    },
    mockSendEmail: vi.fn(),
    mockRenderAndWrap: vi.fn(),
    mockGetDefaultTemplate: vi.fn(),
    mockGetEventTemplate: vi.fn(),
    mockBuildSpeakerEmailContext: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  // Spread the real module: a hand-listed mock silently returns undefined
  // for any export added later, which breaks this suite for whoever adds it.
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
  sendEmail: (args: unknown) => mockSendEmail(args),
  getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
  getDefaultTemplate: (slug: string) => mockGetDefaultTemplate(slug),
  renderMessageValue: vi.fn((m: string) => m),
  renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com", name: "From" }),
  brandingCc: vi.fn().mockReturnValue([]),
  };
});
vi.mock("@/lib/speaker-agreement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speaker-agreement")>();
  return {
    ...actual,
    buildSpeakerEmailContext: (...args: unknown[]) => mockBuildSpeakerEmailContext(...args),
    generateSpeakerAgreementDocx: vi.fn(),
    generateSpeakerAgreementPdf: vi.fn(),
    pickAgreementAttachmentMode: vi.fn(),
    mintSpeakerAgreementLink: vi.fn().mockResolvedValue("https://x.com/agree"),
  };
});
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

import { executeBulkEmail, bulkEmailSchema } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  slug: "osh",
  name: "OSH",
  startDate: new Date("2026-07-01"),
  venue: "Dubai",
  address: null,
  settings: {},
  emailFromAddress: "from@x.com",
  emailFromName: "From",
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

const SPEAKERS = [
  { id: "spk-1", email: "dr@x.com", additionalEmail: null, firstName: "Aisha", lastName: "Khan", title: "DR" },
  { id: "spk-2", email: "observer@x.com", additionalEmail: null, firstName: "Omar", lastName: "Ali", title: "DR" },
];

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "speakers" as const,
  emailType: "custom" as const,
  customSubject: "Hello",
  customMessage: "World",
  organizerName: "Org",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

function bccOfCallTo(email: string): Array<{ email: string }> | undefined {
  const call = mockSendEmail.mock.calls.find(
    (c) => (c[0] as { to: Array<{ email: string }> }).to[0].email === email,
  );
  expect(call).toBeDefined();
  return (call![0] as { bcc?: Array<{ email: string }> }).bcc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speaker.findMany.mockResolvedValue(SPEAKERS);
  mockGetEventTemplate.mockResolvedValue({
    subject: "{{eventName}}",
    htmlContent: "<p>{{message}}</p>",
    textContent: "{{message}}",
  });
  mockGetDefaultTemplate.mockReturnValue({
    subject: "{{eventName}}",
    htmlContent: "<p>{{message}}</p>",
    textContent: "{{message}}",
  });
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
  mockBuildSpeakerEmailContext.mockResolvedValue(null);
});

describe("executeBulkEmail — BCC observers", () => {
  it("BCCs manual filters.bcc observers on every recipient's email", async () => {
    await executeBulkEmail({ ...BASE_INPUT, filters: { bcc: ["Watch@Example.com"] } });
    expect(bccOfCallTo("dr@x.com")).toEqual([{ email: "watch@example.com" }]);
    expect(bccOfCallTo("observer@x.com")).toEqual([{ email: "watch@example.com" }]);
  });

  it("bccSelf resolves to the ORGANIZER at send time (schedule-compat: no enqueue-time email needed)", async () => {
    await executeBulkEmail({ ...BASE_INPUT, filters: { bccSelf: true } });
    expect(bccOfCallTo("dr@x.com")).toEqual([{ email: "org@x.com" }]);
  });

  it("a recipient is never BCC'd on their own email", async () => {
    // observer@x.com is BOTH a bcc observer and a recipient — their own email
    // must not BCC them, everyone else's does.
    await executeBulkEmail({ ...BASE_INPUT, filters: { bcc: ["observer@x.com"], bccSelf: true } });
    expect(bccOfCallTo("dr@x.com")).toEqual(
      expect.arrayContaining([{ email: "observer@x.com" }, { email: "org@x.com" }]),
    );
    expect(bccOfCallTo("observer@x.com")).toEqual([{ email: "org@x.com" }]);
  });

  it("no bcc filters ⇒ bcc undefined (unchanged sends)", async () => {
    await executeBulkEmail({ ...BASE_INPUT, filters: {} });
    expect(bccOfCallTo("dr@x.com")).toBeUndefined();
  });
});

describe("bulkEmailSchema — bcc validation", () => {
  const base = { recipientType: "speakers", emailType: "custom", customSubject: "s", customMessage: "m" };

  it("accepts filters.bcc + filters.bccSelf", () => {
    const parsed = bulkEmailSchema.safeParse({ ...base, filters: { bcc: ["a@x.com"], bccSelf: true } });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-email bcc entry", () => {
    expect(bulkEmailSchema.safeParse({ ...base, filters: { bcc: ["not-an-email"] } }).success).toBe(false);
  });

  it("caps bcc at 10 addresses", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `a${i}@x.com`);
    expect(bulkEmailSchema.safeParse({ ...base, filters: { bcc: eleven } }).success).toBe(false);
  });
});
