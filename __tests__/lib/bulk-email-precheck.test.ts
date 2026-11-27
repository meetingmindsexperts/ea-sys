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
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpCampaign: { findFirst: vi.fn() },
    certificateAssignment: { groupBy: vi.fn() },
  },
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
  loadActiveEventTemplateRow: vi.fn(),
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
import { loadActiveEventTemplateRow } from "@/lib/email";

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

  it("throws 400 when nobody is assigned a selected certificate template", async () => {
    mockLoadCertTemplate.mockResolvedValue({
      id: "tpl-1",
      name: "Attendance",
      category: "ATTENDANCE",
      template: {},
    });
    mockDb.certificateAssignment.groupBy.mockResolvedValue([]); // no rows: nobody assigned
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "certificate",
        filters: { certificateTemplateIds: ["tpl-1"] },
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Nobody is assigned") });
    // The count leaves cancelled registrations out, like every reader.
    expect(mockDb.certificateAssignment.groupBy.mock.calls[0][0].where).toMatchObject({
      certificateTemplateId: { in: ["tpl-1"] },
      OR: [{ speakerId: { not: null } }, { registration: { status: { not: "CANCELLED" } } }],
    });
  });

  it("returns loaded certTemplates for a certificate send that has people assigned", async () => {
    mockLoadCertTemplate.mockResolvedValue({
      id: "tpl-1",
      name: "Attendance",
      category: "ATTENDANCE",
      template: {},
    });
    mockDb.certificateAssignment.groupBy.mockResolvedValue([
      { certificateTemplateId: "tpl-1", _count: { _all: 3 } },
    ]);
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

// ── An RSVP token with no RSVP chosen is refused at enqueue (Sep 11, 2026) ──
describe("precheckBulkEmailViability: {{rsvpButton}} / {{rsvpLink}} without an RSVP chosen", () => {
  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1", name: "Ev", slug: "ev" });
  });

  it("a saved template carrying the token, no campaign: 400 INVALID_FILTER naming the picker", async () => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue({ subject: "Join", htmlContent: "<p>{{<span>rsvpButton</span>}}</p>", textContent: "" } as never);
    await expect(
      precheckBulkEmailViability({ eventId: "evt-1", recipientType: "registrations", emailType: "template", filters: { templateSlug: "joining" } }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
  });

  it("a custom message carrying the token, no campaign: refused too", async () => {
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1", recipientType: "registrations", emailType: "custom",
        customSubject: "Seat", customMessage: "Confirm here: {{rsvpLink}}",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_FILTER" });
  });

  it("the same template with an RSVP chosen passes", async () => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue({ subject: "Join", htmlContent: "<p>{{rsvpButton}}</p>", textContent: "" } as never);
    mockDb.rsvpCampaign.findFirst.mockResolvedValue({ id: "camp-1", name: "Attendance", isActive: true });
    const res = await precheckBulkEmailViability({
      eventId: "evt-1", recipientType: "registrations", emailType: "template",
      filters: { templateSlug: "joining", rsvpCampaignId: "camp-1" },
    });
    expect(res.rsvpCampaign).toEqual({ id: "camp-1", name: "Attendance" });
  });
});

describe("precheckBulkEmailViability — saved templates resolve at enqueue (comms R2 A3, Sep 18 2026)", () => {
  it("a missing or inactive saved template is a 400 with TEMPLATE_NOT_AVAILABLE, before the event load", async () => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue(null);
    await expect(
      precheckBulkEmailViability({
        eventId: "evt-1",
        recipientType: "registrations",
        emailType: "template",
        filters: { templateSlug: "joining-instructions" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "TEMPLATE_NOT_AVAILABLE", message: expect.stringContaining("joining-instructions") });
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("a saved template send with no slug is a 400", async () => {
    await expect(
      precheckBulkEmailViability({ eventId: "evt-1", recipientType: "registrations", emailType: "template", filters: {} }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("an active saved template passes, and its row is read once", async () => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue({ subject: "s", htmlContent: "<p>hi</p>", textContent: "hi" } as never);
    const res = await precheckBulkEmailViability({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "template",
      filters: { templateSlug: "joining-instructions" },
    });
    expect(res.event.id).toBe("evt-1");
    expect(loadActiveEventTemplateRow).toHaveBeenCalledTimes(1);
  });

  it("a reviewer invitation is refused as a bulk email: it is sent from the Reviewers page", async () => {
    await expect(
      precheckBulkEmailViability({ eventId: "evt-1", recipientType: "reviewers", emailType: "invitation" }),
    ).rejects.toMatchObject({ status: 400 });
    // A custom email to reviewers still goes.
    const res = await precheckBulkEmailViability({ eventId: "evt-1", recipientType: "reviewers", emailType: "custom", customSubject: "Reminder", customMessage: "Please review by Friday." });
    expect(res.event.id).toBe("evt-1");
  });
});

describe("a saved template that names a token its audience's send does not set (Nov 27, 2026)", () => {
  const send = (recipientType: "registrations" | "speakers", htmlContent: string) => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue({ subject: "For {{firstName}}", htmlContent, textContent: "" } as never);
    return precheckBulkEmailViability({ eventId: "evt-1", recipientType, emailType: "template", filters: { templateSlug: "mine" } });
  };

  it("is refused when scheduled, naming the token and who it is for", async () => {
    const err = await send("registrations", "<p>Your fee: {{honorarium}}</p>").catch((e) => e);
    expect(err).toBeInstanceOf(BulkEmailError);
    expect(err.code).toBe("TOKENS_NOT_SET");
    expect(err.message).toContain("{{honorarium}} is filled only when sending to speakers");
    expect(err.message).toContain("This template cannot go to registrations as it is");
  });

  it("goes through for the audience the token belongs to", async () => {
    await expect(send("speakers", "<p>Your fee: {{honorarium}}</p>")).resolves.toBeTruthy();
    await expect(send("registrations", "<p>You owe {{amount}}</p>{{paymentBlock}}")).resolves.toBeTruthy();
  });

  it("refuses a token no send sets, as a spelling to check", async () => {
    const err = await send("registrations", "<p>Dear {{frstName}}</p>").catch((e) => e);
    expect(err.code).toBe("TOKENS_NOT_SET");
    expect(err.message).toContain("{{frstName}} is not a token this email can use (check its spelling)");
  });

  it("names every audience a token belongs to", async () => {
    const err = await send("registrations", "<p>{{presenterAgreementLink}}</p>").catch((e) => e);
    expect(err.message).toContain("{{presenterAgreementLink}} is filled only when sending to speakers or abstract authors");
  });

  it("goes by the subject and the HTML, as the send's own guard does: a leftover in the text part or a typed note is not refused here", async () => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue({ subject: "Hello", htmlContent: "<p>Hi</p>", textContent: "Old: {{honorarium}}" } as never);
    await expect(
      precheckBulkEmailViability({ eventId: "evt-1", recipientType: "registrations", emailType: "template", filters: { templateSlug: "mine" }, customMessage: "{{honorarium}}" }),
    ).resolves.toBeTruthy();
  });

  it("leaves the block tokens that are empty for another audience alone (they send today)", async () => {
    await expect(send("registrations", "<p>{{presentationDetails}} {{agreementBlock}} {{speakerName}}</p>")).resolves.toBeTruthy();
  });
});

describe("a typed email is held to the token map as a saved template is (Nov 27, 2026)", () => {
  const typed = (recipientType: "registrations" | "speakers" | "abstracts", customSubject: string, customMessage: string) =>
    precheckBulkEmailViability({ eventId: "evt-1", recipientType, emailType: "custom", customSubject, customMessage });

  it("refuses a token meant for another audience, in the message or the subject", async () => {
    const inMessage = await typed("registrations", "Hello", "Your fee is {{honorarium}}").catch((e) => e);
    expect(inMessage.code).toBe("TOKENS_NOT_SET");
    expect(inMessage.message).toContain("This email cannot go to registrations as it is: {{honorarium}} is filled only when sending to speakers");
    expect(inMessage.message).toContain("Change the subject or the message");
    const inSubject = await typed("speakers", "You owe {{amount}}", "Hello").catch((e) => e);
    expect(inSubject.message).toContain("{{amount}} is filled only when sending to registrations");
  });

  it("refuses a spelling, and the typed text naming itself", async () => {
    expect((await typed("registrations", "Hi", "Dear {{frstName}}").catch((e) => e)).message).toContain("{{frstName}} is not a token this email can use");
    expect((await typed("registrations", "Hi", "See {{message}}").catch((e) => e)).message).toContain("{{message}} cannot be used inside the typed subject or message");
  });

  it("says an abstract's own detail needs a saved template sent to abstract authors, whoever the typed email goes to", async () => {
    for (const audience of ["abstracts", "registrations"] as const) {
      const err = await typed(audience, "Your abstract", "About {{abstractTitle}}").catch((e) => e);
      expect(err.message).toContain("{{abstractTitle}} is one abstract's own detail: it is filled only in a saved template sent to abstract authors");
    }
  });

  it("lets the message quote the subject, and refuses the subject naming itself", async () => {
    await expect(typed("registrations", "Your place", "Re: {{subject}}")).resolves.toBeTruthy();
    expect((await typed("registrations", "About {{subject}}", "Hello").catch((e) => e)).message).toContain("{{subject}} cannot be used inside the typed subject or message");
  });

  it("refuses the RSVP's name with no RSVP chosen, like the link and the button", async () => {
    const err = await typed("registrations", "Join {{rsvpName}}", "Hello").catch((e) => e);
    expect(err.message).toContain("but no RSVP was chosen");
  });

  it("lets through what its audience gets: the balance for registrations, the fee for speakers, the event block for everyone", async () => {
    await expect(typed("registrations", "You owe {{amount}}", "Dear {{firstName}}, {{amount}} {{paymentBlock}} {{eventDateRange}}")).resolves.toBeTruthy();
    await expect(typed("speakers", "Hi {{title}} {{lastName}}", "{{presentationDetails}} {{honorarium}}")).resolves.toBeTruthy();
    await expect(typed("abstracts", "Hi", "{{authorName}}: {{managementLink}}")).resolves.toBeTruthy();
  });
});
