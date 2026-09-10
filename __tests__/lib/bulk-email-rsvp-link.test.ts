/**
 * executeBulkEmail (bulk-email.ts): {{rsvpLink}} in a general send
 * (organizer request, Sep 10, 2026).
 *
 * The RSVP link used to be reachable only from the RSVP console's own send.
 * Now `filters.rsvpCampaignId` on any registrations/speakers send renders each
 * recipient's PERSONAL link. The rules pinned here:
 *   - the guest list is read once and matched on the normalised email;
 *   - a recipient with no invite is SKIPPED and counted (never a blank link,
 *     never auto-invited: the console is the only place a roster grows);
 *   - no campaign chosen ⇒ nothing is read and nothing is skipped.
 *
 * Rendering and transport are mocked; the assertions are on which recipients
 * reach sendEmail and on the vars handed to the renderer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockSendEmail,
  mockRenderAndWrap,
  mockGetDefaultTemplate,
  mockGetEventTemplate,
  mockWarn,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    rsvpCampaign: { findFirst: vi.fn() },
    rsvpInvite: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockSendEmail: vi.fn(),
  mockRenderAndWrap: vi.fn(),
  mockGetDefaultTemplate: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: mockWarn, debug: vi.fn() },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
    getDefaultTemplate: (...args: unknown[]) => mockGetDefaultTemplate(...args),
    renderMessageValue: vi.fn((m: string) => m),
    renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
    brandingFrom: vi.fn(),
    brandingCc: vi.fn(),
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
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  organizationId: "org-1",
  slug: "oopvf",
  name: "Oman Oncology Pharmacy Value Forum 2026",
  startDate: new Date("2026-09-12"),
  timezone: "Asia/Muscat",
  venue: "Muscat",
  city: null,
  country: null,
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
  travelGrantMessageHtml: null,
  surveyConfig: null,
  taxRate: null,
  taxLabel: null,
};

const reg = (id: string, email: string, firstName: string) => ({
  id,
  serialId: 1,
  qrCode: null,
  attendanceMode: "IN_PERSON",
  originalPrice: null,
  discountAmount: null,
  pricingTier: null,
  ticketType: { name: "Delegate", price: 0, currency: "USD" },
  attendee: { email, additionalEmail: null, firstName, lastName: "Doe", title: "DR" },
});

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  emailType: "custom" as const,
  customSubject: "Joining instructions",
  customMessage: "Please confirm your seat: {{rsvpLink}}",
  organizerName: "Org Anizer",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

const TEMPLATE = { subject: "{{subject}}", htmlContent: "<p>{{message}}</p>", textContent: "{{message}}" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findMany.mockResolvedValue([
    reg("reg-jane", "jane@x.com", "Jane"),
    reg("reg-bob", "bob@x.com", "Bob"),
  ]);
  mockDb.rsvpCampaign.findFirst.mockResolvedValue({ id: "camp-1", name: "Forum RSVP", isActive: true });
  mockDb.rsvpInvite.findMany.mockResolvedValue([]);
  mockGetEventTemplate.mockResolvedValue(TEMPLATE);
  mockGetDefaultTemplate.mockReturnValue(TEMPLATE);
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
});

const sentTo = () => mockSendEmail.mock.calls.map((c) => (c[0] as { to: { email: string }[] }).to[0].email);
const varsFor = (email: string) =>
  mockRenderAndWrap.mock.calls
    .map((c) => c[1] as Record<string, string>)
    .find((v) => v.firstName === (email === "jane@x.com" ? "Jane": "Bob"));

describe("executeBulkEmail: {{rsvpLink}} from filters.rsvpCampaignId", () => {
  it("renders each invited recipient's personal link and skips the rest, counted", async () => {
    mockDb.rsvpInvite.findMany.mockResolvedValue([{ inviteeEmail: "jane@x.com", token: "tok-jane" }]);

    const res = await executeBulkEmail({ ...BASE_INPUT, filters: { rsvpCampaignId: "camp-1" } });

    // The guest list is read ONCE, event-bound, for the chosen campaign.
    expect(mockDb.rsvpInvite.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.rsvpInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: "camp-1", eventId: "evt-1" } }),
    );
    // Jane is on the list: she is emailed, with her own token in the link.
    expect(sentTo()).toEqual(["jane@x.com"]);
    expect(varsFor("jane@x.com")).toMatchObject({
      rsvpLink: expect.stringMatching(/\/e\/oopvf\/rsvp\/tok-jane$/),
      rsvpName: "Forum RSVP",
    });
    // Bob is not: skipped, never sent a blank link, never invited.
    expect(res).toMatchObject({ total: 1, successCount: 1, failureCount: 0, skippedCount: 1 });
    expect(res.skippedReason).toContain("Forum RSVP");
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "bulk-email:rsvp-link-recipients-skipped",
        skipped: 1,
        sending: 1,
        skippedRecipientIds: ["reg-bob"],
      }),
    );
  });

  it("matches the invite on the normalised email, as the invite's own unique key does", async () => {
    mockDb.rsvpInvite.findMany.mockResolvedValue([{ inviteeEmail: "  Bob@X.COM ", token: "tok-bob" }]);
    const res = await executeBulkEmail({ ...BASE_INPUT, filters: { rsvpCampaignId: "camp-1" } });
    expect(sentTo()).toEqual(["bob@x.com"]);
    expect(varsFor("bob@x.com")?.rsvpLink).toMatch(/\/rsvp\/tok-bob$/);
    expect(res.skippedCount).toBe(1);
  });

  it("with nobody on the guest list, sends nothing and reports everyone skipped (no throw)", async () => {
    const res = await executeBulkEmail({ ...BASE_INPUT, filters: { rsvpCampaignId: "camp-1" } });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(res).toMatchObject({ total: 0, successCount: 0, failureCount: 0, skippedCount: 2 });
  });

  it("no campaign chosen ⇒ the guest list is never read, nobody is skipped, no rsvpLink var", async () => {
    const res = await executeBulkEmail({ ...BASE_INPUT, customMessage: "Plain message" });
    expect(mockDb.rsvpCampaign.findFirst).not.toHaveBeenCalled();
    expect(mockDb.rsvpInvite.findMany).not.toHaveBeenCalled();
    expect(sentTo().sort()).toEqual(["bob@x.com", "jane@x.com"]);
    expect(varsFor("jane@x.com")?.rsvpLink).toBeUndefined();
    expect(res.skippedCount).toBeUndefined();
    expect(res.skippedReason).toBeUndefined();
  });

  it("the link renders raw (a URL we built), so the renderer is told not to escape it", async () => {
    mockDb.rsvpInvite.findMany.mockResolvedValue([{ inviteeEmail: "jane@x.com", token: "tok-jane" }]);
    await executeBulkEmail({ ...BASE_INPUT, filters: { rsvpCampaignId: "camp-1" } });
    const rawKeys = mockRenderAndWrap.mock.calls[0][3] as Set<string>;
    expect(rawKeys.has("rsvpLink")).toBe(true);
  });
});
