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

const { mockDb, mockSendEmail, tokenRefusal, renderedVars } = vi.hoisted(() => ({
  // The variables each email was rendered with, as the pipeline handed them over.
  renderedVars: [] as Array<Record<string, unknown>>,
  // Off for the one case that proves what the refusal claims: those tokens really are left unset.
  tokenRefusal: { on: true },
  mockDb: {
    event: { findFirst: vi.fn() },
    emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    registration: { findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    speaker: { findMany: vi.fn() },
    abstract: { findMany: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
    survey: { findFirst: vi.fn().mockResolvedValue(null) },
    speakerProfileForm: { upsert: vi.fn().mockResolvedValue({ id: "form1", token: "tok_form", status: "PENDING" }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    emailLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockSendEmail: vi.fn(),
}));

// $transaction: the presenter agreement's link is minted in one (the real resolver runs).
vi.mock("@/lib/db", () => ({
  db: { ...mockDb, $transaction: (ops: unknown[]) => Promise.all(ops) },
  tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/email-token-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email-token-map")>();
  return {
    ...actual,
    emailTokenRefusal: (...args: Parameters<typeof actual.emailTokenRefusal>) =>
      tokenRefusal.on ? actual.emailTokenRefusal(...args) : null,
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    renderAndWrap: (...args: Parameters<typeof actual.renderAndWrap>) => {
      renderedVars.push(args[1]);
      return actual.renderAndWrap(...args);
    },
  };
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
  savedTemplatePaymentVars: vi.fn().mockReturnValue({ amount: "USD 105.00", paymentBlock: "<div>Pay now</div>" }),
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
import { ABSTRACT_OWN_TOKEN_KEYS, EMAIL_TOKEN_MAP, tokensSetFor } from "@/lib/email-token-map";

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
  // Read by the registration-form checks (registration-form-service).
  status: "CONFIRMED", userId: null, refundedAmount: 0, groupId: null, promoCodeId: null, sponsorId: null,
  ticketTypeId: "tt-1", pricingTierId: null, createdSource: "CSV_IMPORT",
  _count: { payments: 0, invoices: 0 },
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
  tokenRefusal.on = true;
  renderedVars.length = 0;
});

/** Every (type, audience) the registry says the bulk pipeline sends. The webinar sequence has no dropdown entry; it goes to registrations. */
const CASES: Array<{ slug: string; type: string; audience: BulkEmailAudience }> = [];
for (const t of EMAIL_TEMPLATE_SPECS) {
  if (!t.bulk) continue;
  const audiences = t.bulk.audiences.length > 0 ? t.bulk.audiences.map((a) => a.audience) : (["registrations"] as const);
  for (const audience of audiences) CASES.push({ slug: t.slug, type: t.bulk.type, audience });
}

describe("bulk pipeline: every registered (type, audience) renders its default template with nothing unresolved", () => {
  it("covers the seventeen bulk types the registry declares", () => {
    expect(new Set(CASES.map((c) => c.type)).size).toBe(17);
  });

  it.each(CASES)("$type → $audience ($slug)", async ({ type, audience }) => {
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow(ABSTRACT_STATUS_FOR_TYPE[type] ?? "SUBMITTED")]);

    const res = await executeBulkEmail({
      eventId: "evt-1",
      recipientType: audience,
      emailType: type as never,
      // The registration form needs its rate; Complimentary needs no rate row.
      filters: type === "registration-form" ? { registrationFormRate: "_complimentary" } : {},
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

/**
 * The saved-template twin (Nov 27, 2026; docs/EMAIL_TOKEN_MAP_PLAN.md step 0).
 * The cases above pin the built-in templates; nothing pinned a SAVED template,
 * so a copy of the payment reminder was refused on {{amount}} for a whole
 * audience. A saved template naming EVERY token the map says a send to that
 * audience sets must come out with nothing unresolved. The three RSVP tokens
 * are left out: they need an RSVP picked, and the precheck refuses them without one.
 */
describe("bulk pipeline: a saved template naming every token of its audience renders with nothing unresolved", () => {
  const AUDIENCES: BulkEmailAudience[] = ["registrations", "speakers", "reviewers", "abstracts"];

  it.each(AUDIENCES)("%s", async (audience) => {
    const body = tokensSetFor(audience).map((k) => `{{${k}}}`).join(" ");
    mockDb.emailTemplate.findUnique.mockResolvedValue({
      id: "tpl-1", eventId: "evt-1", slug: "my-saved-template", name: "Mine", isActive: true,
      subject: "For {{firstName}}", htmlContent: `<p>${body}</p>`, textContent: body,
    });
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);

    const res = await executeBulkEmail({
      eventId: "evt-1",
      recipientType: audience,
      emailType: "template",
      filters: { templateSlug: "my-saved-template" },
      organizerName: "Organizer",
      organizerEmail: "org@x.test",
      organizationId: "org-1",
      triggeredByUserId: "user-1",
    });

    expect(res.failureCount, `${audience}: ${JSON.stringify(res.errors)}`).toBe(0);
    expect(mockSendEmail).toHaveBeenCalled();
    for (const call of mockSendEmail.mock.calls) {
      const params = call[0] as { subject: string; htmlContent: string; textContent?: string };
      expect(findUnresolvedTokens(params.subject, params.htmlContent), `${audience}: unresolved in subject or body`).toEqual([]);
      expect(findUnresolvedTokens(params.textContent), `${audience}: unresolved in the text part`).toEqual([]);
    }
  });

  // Naming every token above makes the abstracts send once per ABSTRACT. A
  // template that names none of an abstract's own goes once per author.
  it("abstracts, once per author: the author's own tokens and everyone's", async () => {
    const own = new Set<string>(ABSTRACT_OWN_TOKEN_KEYS);
    const body = tokensSetFor("abstracts").filter((k) => !own.has(k)).map((k) => `{{${k}}}`).join(" ");
    mockDb.emailTemplate.findUnique.mockResolvedValue({
      id: "tpl-1", eventId: "evt-1", slug: "my-saved-template", name: "Mine", isActive: true,
      subject: "For {{authorName}}", htmlContent: `<p>${body}</p>`, textContent: body,
    });
    mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);
    const res = await executeBulkEmail({
      eventId: "evt-1", recipientType: "abstracts", emailType: "template", filters: { templateSlug: "my-saved-template" },
      organizerName: "Organizer", organizerEmail: "org@x.test", organizationId: "org-1", triggeredByUserId: "user-1",
    });
    expect(res.failureCount, JSON.stringify(res.errors)).toBe(0);
    const params = mockSendEmail.mock.calls[0][0] as { subject: string; htmlContent: string };
    expect(findUnresolvedTokens(params.subject, params.htmlContent)).toEqual([]);
  });

  // And the map leaves nothing out: a saved-template send hands the renderer no
  // variable the map does not list for that audience. Without this, a token the
  // send sets and the map lacks would be refused at scheduling though it works.
  it.each([...AUDIENCES.map((a) => ({ audience: a, perAbstract: false })), { audience: "abstracts" as const, perAbstract: true }])(
    "$audience (per abstract: $perAbstract): the send sets nothing the map does not list",
    async ({ audience, perAbstract }) => {
      mockDb.emailTemplate.findUnique.mockResolvedValue({
        id: "tpl-1", eventId: "evt-1", slug: "my-saved-template", name: "Mine", isActive: true,
        subject: "Hello", htmlContent: perAbstract ? "<p>{{abstractTitle}}</p>" : "<p>Hi {{firstName}}</p>", textContent: "x",
      });
      if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);
      await executeBulkEmail({
        eventId: "evt-1", recipientType: audience, emailType: "template", filters: { templateSlug: "my-saved-template" },
        organizerName: "Organizer", organizerEmail: "org@x.test", organizationId: "org-1", triggeredByUserId: "user-1",
      });
      expect(renderedVars.length).toBeGreaterThan(0);
      const listed = new Set<string>(tokensSetFor(audience, { withRsvp: true }));
      const extra = [...new Set(renderedVars.flatMap((v) => Object.keys(v)))].filter((k) => !listed.has(k));
      expect(extra).toEqual([]);
    },
  );

  // {{subject}} and {{message}} are the typed subject and note: set for a typed
  // email and a saved template, never for a built-in type, whose template is
  // refused if it names one (an empty subject line otherwise; review of 67cd33d23).
  it("a built-in type does not get {{subject}} or {{message}}", async () => {
    await executeBulkEmail({
      eventId: "evt-1", recipientType: "registrations", emailType: "reminder", filters: {}, customMessage: "A note",
      organizerName: "Organizer", organizerEmail: "org@x.test", organizationId: "org-1", triggeredByUserId: "user-1",
    });
    expect(renderedVars.length).toBeGreaterThan(0);
    for (const v of renderedVars) {
      expect(v).not.toHaveProperty("subject");
      expect(v).not.toHaveProperty("message");
    }
  });

  // The other direction: what the map says an audience does NOT get, the send
  // really leaves unset, so refusing it when the send is scheduled
  // (emailTokenRefusal, switched off here to reach the send) stops
  // nothing that would have gone out.
  it.each(AUDIENCES)("%s: every token the map gives only to other audiences is left unset", async (audience) => {
    tokenRefusal.on = false;
    const set = new Set<string>(tokensSetFor(audience, { withRsvp: true }));
    const others = Object.keys(EMAIL_TOKEN_MAP).filter((k) => !set.has(k));
    mockDb.emailTemplate.findUnique.mockResolvedValue({
      id: "tpl-1", eventId: "evt-1", slug: "my-saved-template", name: "Mine", isActive: true,
      subject: "For {{firstName}}", htmlContent: `<p>${others.map((k) => `{{${k}}}`).join(" ")}</p>`, textContent: "x",
    });
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);

    await executeBulkEmail({
      eventId: "evt-1",
      recipientType: audience,
      emailType: "template",
      filters: { templateSlug: "my-saved-template" },
      organizerName: "Organizer",
      organizerEmail: "org@x.test",
      organizationId: "org-1",
      triggeredByUserId: "user-1",
    });

    expect(mockSendEmail).toHaveBeenCalled();
    const params = mockSendEmail.mock.calls[0][0] as { htmlContent: string };
    expect(findUnresolvedTokens(params.htmlContent).sort()).toEqual([...others].sort());
  });

  // ── A typed email (no saved template) ───────────────────────────────────
  // Its subject and message see what a template sees (applyTypedSubjectAndNote),
  // less an abstract's own tokens (it goes once per author) and less
  // {{subject}} and {{message}}, which are the typed text itself. That is the
  // set the scheduling check holds a typed email to; both directions here.
  const typedInput = (audience: BulkEmailAudience, text: string) => ({
    eventId: "evt-1", recipientType: audience, emailType: "custom" as const, filters: {},
    customSubject: text, customMessage: text,
    organizerName: "Organizer", organizerEmail: "org@x.test", organizationId: "org-1", triggeredByUserId: "user-1",
  });

  it.each(AUDIENCES)("%s, typed: every token of its audience works in the subject and the message", async (audience) => {
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);
    const res = await executeBulkEmail(typedInput(audience, tokensSetFor(audience, { typed: true }).map((k) => `{{${k}}}`).join(" ")));
    expect(res.failureCount, `${audience}: ${JSON.stringify(res.errors)}`).toBe(0);
    const params = mockSendEmail.mock.calls[0][0] as { subject: string; htmlContent: string };
    expect(findUnresolvedTokens(params.subject), "subject").toEqual([]);
    expect(findUnresolvedTokens(params.htmlContent), "message").toEqual([]);
  });

  it.each(AUDIENCES)("%s, typed: every other token is left unset, so refusing it at scheduling stops nothing", async (audience) => {
    tokenRefusal.on = false;
    const set = new Set<string>(tokensSetFor(audience, { withRsvp: true, typed: true }));
    const others = Object.keys(EMAIL_TOKEN_MAP).filter((k) => !set.has(k));
    const text = others.map((k) => `{{${k}}}`).join(" ");
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);
    // In the subject, all of them.
    await executeBulkEmail({ ...typedInput(audience, "x"), customSubject: text });
    expect(findUnresolvedTokens((mockSendEmail.mock.calls[0][0] as { subject: string }).subject).sort()).toEqual([...others].sort());
    // In the message, all but {{subject}}, which the message may quote (review of fa9aede3).
    mockSendEmail.mockClear();
    await executeBulkEmail({ ...typedInput(audience, "x"), customSubject: "Plain subject", customMessage: text });
    const html = (mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent;
    expect(findUnresolvedTokens(html).sort()).toEqual(others.filter((k) => k !== "subject").sort());
    expect(html).toContain("Plain subject");
  });

  it("a typed email to speakers that names the agreement link gets one, as a template does", async () => {
    await executeBulkEmail(typedInput("speakers", "Please sign: {{agreementLink}}"));
    expect((mockSendEmail.mock.calls[0][0] as { htmlContent: string }).htmlContent).toContain("Please sign: https://x.test/agree/abc");
  });

  it.each(AUDIENCES)("%s, typed: the send sets nothing the map does not list", async (audience) => {
    if (audience === "abstracts") mockDb.abstract.findMany.mockResolvedValue([abstractRow("SUBMITTED")]);
    await executeBulkEmail(typedInput(audience, "Hello {{firstName}}"));
    expect(renderedVars.length).toBeGreaterThan(0);
    const listed = new Set<string>(tokensSetFor(audience, { withRsvp: true }));
    expect([...new Set(renderedVars.flatMap((v) => Object.keys(v)))].filter((k) => !listed.has(k))).toEqual([]);
  });

  it("a typed email to registrations carries the balance and Pay Now, in the subject too, and the event's date range", async () => {
    mockDb.registration.findMany.mockResolvedValue([{ ...REGISTRATION, payments: [] }]);
    await executeBulkEmail({ ...typedInput("registrations", "x"), customSubject: "You owe {{amount}}", customMessage: "Dear {{firstName}}, {{amount}} for {{eventDateRange}}. {{paymentBlock}}" });
    const params = mockSendEmail.mock.calls[0][0] as { subject: string; htmlContent: string };
    expect(params.subject).toBe("You owe USD 105.00");
    // The range's own separator is an en dash (buildEventDateTokens).
    expect(params.htmlContent).toContain("USD 105.00 for October 2 \u2013 3, 2026");
    expect(params.htmlContent).toContain("Pay now");
  });
});
