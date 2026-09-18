/**
 * Sender-to-template drift, the two per-person send routes: for every
 * built-in type the registry says each route accepts, POST it, render the
 * real DEFAULT template through the real renderer, and assert the email
 * sendEmail receives carries no unresolved {{token}}.
 *
 * The registration confirmation and the survey invitation are delegated by
 * their route (to the confirmation sender and the bulk pipeline) and are
 * covered there; the types rendered by the routes themselves are what this
 * pins. Cases come from the registry, so a type added to a route's surface is
 * covered the day it is added.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, sendEmailSpy } = vi.hoisted(() => ({
  mockDb: {
    rsvpInvite: { findMany: vi.fn().mockResolvedValue([]) },
    emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  sendEmailSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number; headers?: Record<string, string> }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: (k: string) => i?.headers?.[k] ?? null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (cb: (tx: unknown) => unknown) => cb(mockDb) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, cb: () => unknown) => cb() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0, remaining: 1 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => sendEmailSpy(...args),
    // The confirmation type is delegated to the automatic sender (its own tests).
    sendRegistrationConfirmation: vi.fn().mockResolvedValue({ success: true }),
  };
});
// The survey type is delegated to the bulk pipeline (the bulk drift test).
vi.mock("@/lib/bulk-email", () => ({ executeBulkEmail: vi.fn(), BulkEmailError: class extends Error {} }));
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn().mockResolvedValue({ html: "<img alt=\"barcode\">", text: "QR-007" }),
  templateUsesEntryBarcode: () => false,
}));
vi.mock("@/lib/email-change", () => ({ normalizeEmail: (e: string) => e.toLowerCase(), repointOrgContactEmail: vi.fn() }));
vi.mock("@/lib/email-attachments", () => ({ resolveStoredAttachments: vi.fn().mockResolvedValue({ ok: true, attachments: [] }) }));
vi.mock("@/lib/email-attachment-limits", () => ({ MAX_MANUAL_ATTACHMENTS: 3 }));
vi.mock("@/lib/speaker-agreement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speaker-agreement")>();
  return {
    ...actual,
    buildSpeakerEmailContext: vi.fn().mockResolvedValue({
      title: "Dr.",
      speakerName: "Dr. Jane Doe",
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

import { POST as registrationPost } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";
import { POST as speakerPost } from "@/app/api/events/[eventId]/speakers/[speakerId]/email/route";
import { findUnresolvedTokens } from "@/lib/template-tokens";
import { singleSendTypesFor } from "@/lib/email-template-registry";

const EVENT = {
  id: "ev1", slug: "my-event", name: "My Event", startDate: new Date("2026-11-01T05:00:00Z"), endDate: new Date("2026-11-02T14:00:00Z"),
  timezone: "Asia/Dubai", venue: "DWTC", city: "Dubai", country: "UAE", address: "Trade Centre",
  taxRate: 5, taxLabel: "VAT", bankDetails: null, supportEmail: null, organizationId: "org1",
  emailFromAddress: null, emailFromName: null, emailCcAddresses: [], emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null,
  speakerAgreementTemplate: null, speakerAgreementHtml: "<p>Agreement text</p>",
  organization: { name: "MMG", companyName: null, companyAddress: null, companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, taxId: null, logo: null },
};

const REGISTRATION = {
  id: "reg1", serialId: 7, eventId: "ev1", qrCode: "QR", attendanceMode: "IN_PERSON", status: "CONFIRMED", paymentStatus: "UNPAID",
  originalPrice: 400, discountAmount: null, surveyCompletedAt: null, userId: null,
  attendee: { firstName: "Amal", lastName: "Baker", email: "a@b.test", additionalEmail: null, title: "DR", organization: null, jobTitle: null, city: null, country: null },
  ticketType: { name: "Standard", price: 0, currency: "USD" },
  pricingTier: { name: "Early Bird", price: 400, currency: "USD" },
  promoCode: null,
  billingFirstName: null, billingLastName: null, billingEmail: null, billingPhone: null,
  billingAddress: null, billingCity: null, billingState: null, billingZipCode: null, billingCountry: null, taxNumber: null,
};

const SPEAKER = {
  id: "sp1", email: "spk@x.test", firstName: "Jane", lastName: "Doe", title: "DR", additionalEmail: null, agreementAcceptedAt: null, sessions: [],
};

const SENDER = { id: "u1", firstName: "Org", lastName: "Anizer", email: "org@x.test", emailSignature: "<p>Org</p>" };

function req(url: string, body: Record<string, unknown>) {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function assertClean(label: string) {
  expect(sendEmailSpy, label).toHaveBeenCalled();
  for (const call of sendEmailSpy.mock.calls) {
    const p = call[0] as { subject: string; htmlContent: string; textContent?: string };
    expect(findUnresolvedTokens(p.subject, p.htmlContent), `${label}: unresolved in subject or body`).toEqual([]);
    expect(findUnresolvedTokens(p.textContent), `${label}: unresolved in the text part`).toEqual([]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1", email: "org@x.test" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.registration.findFirst.mockResolvedValue(REGISTRATION);
  mockDb.speaker.findFirst.mockResolvedValue(SPEAKER);
  mockDb.user.findUnique.mockResolvedValue(SENDER);
  mockDb.emailTemplate.findUnique.mockResolvedValue(null);
  mockDb.rsvpInvite.findMany.mockResolvedValue([]);
  sendEmailSpy.mockResolvedValue({ success: true, messageId: "m1" });
});

/** Types the route renders itself (the two delegated ones are covered by their own senders). */
const DELEGATED = new Set(["confirmation", "survey-invitation"]);
const REGISTRATION_TYPES = singleSendTypesFor("registration", { route: true }).map((s) => s.type).filter((t) => !DELEGATED.has(t));
const SPEAKER_TYPES = singleSendTypesFor("speaker", { route: true }).map((s) => s.type);

describe("registration record, Send Email: every built-in type renders its default template with nothing unresolved", () => {
  it("has the three route-rendered types", () => {
    expect(REGISTRATION_TYPES.sort()).toEqual(["custom", "payment-reminder", "reminder"]);
  });

  it.each(REGISTRATION_TYPES)("%s", async (type) => {
    const res = await registrationPost(
      req("http://t/api/events/ev1/registrations/reg1/email", { type, customSubject: "A note for {{firstName}}", customMessage: "Please read this." }),
      { params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }) },
    );
    expect(res.status, `${type}: ${JSON.stringify(await res.json())}`).toBe(200);
    assertClean(`registration/${type}`);
  });
});

describe("speaker page, Send Email: every built-in type renders its default template with nothing unresolved", () => {
  it("has the three route-rendered types", () => {
    expect(SPEAKER_TYPES.sort()).toEqual(["agreement", "custom", "invitation"]);
  });

  it.each(SPEAKER_TYPES)("%s", async (type) => {
    const res = await speakerPost(
      req("http://t/api/events/ev1/speakers/sp1/email", { type, customSubject: "A note for {{firstName}}", customMessage: "Please read this." }),
      { params: Promise.resolve({ eventId: "ev1", speakerId: "sp1" }) },
    );
    expect(res.status, `${type}: ${JSON.stringify(await res.json())}`).toBe(200);
    assertClean(`speaker/${type}`);
  });
});
