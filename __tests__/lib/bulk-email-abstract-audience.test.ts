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

const { mockDb, sendEmail, resolveTravelGrantBlock, presenterMint, presenterPdf } = vi.hoisted(() => ({
  mockDb: {
    user: { findMany: vi.fn() },
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
  // The ONE resolver both the automatic confirmation and the bulk resend use;
  // its own rules (home / unknown / declined) are pinned in travel-grant-block.test.ts.
  resolveTravelGrantBlock: vi.fn().mockResolvedValue({ html: "", text: "" }),
  presenterMint: vi.fn(),
  presenterPdf: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail,
    loadActiveEventTemplateRow: vi.fn(),
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
vi.mock("@/lib/travel-grant/server", () => ({ resolveTravelGrantBlock }));
vi.mock("@/lib/presenter-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/presenter-agreement")>()),
  mintPresenterAgreementLink: presenterMint,
  generatePresenterAgreementPdf: presenterPdf,
}));

import { executeBulkEmail, previewAbstractEmailVars } from "@/lib/bulk-email";
import { renderAndWrap, getEventTemplate, loadActiveEventTemplateRow } from "@/lib/email";
import { buildAbstractConfirmationVars, buildAbstractDecisionVars } from "@/lib/abstract-notifications";
import { ABSTRACT_OWN_TOKENS } from "@/lib/bulk-email-audience";

const EVENT = {
  id: "evt-1", organizationId: "org-1", slug: "hemnet", name: "HEMNET 2026", startDate: new Date("2026-07-01"), venue: "Dubai", address: null,
  settings: {}, emailFromAddress: null, emailFromName: null, emailCcAddresses: null, emailHeaderImage: null,
  emailFooterImage: null, emailFooterHtml: null, speakerAgreementTemplate: null, speakerAgreementHtml: null,
  surveyConfig: null, taxRate: null, taxLabel: null, timezone: "Asia/Dubai",
  travelGrantMessageHtml: "<p>We help with flights.</p>",
};
const SPEAKER = { id: "spk-1", email: "jane@x.com", additionalEmail: null, firstName: "Jane", lastName: "Doe", title: "DR", country: "Egypt" };
const abstractRow = (over: Record<string, unknown>) => ({
  id: "abs-1", title: "Iron in HF", serialId: 7, presentationType: "ORAL", coAuthors: null, status: "SUBMITTED",
  theme: { name: "Cardiology" }, submissions: [], speaker: SPEAKER, ...over,
});
const BASE = { eventId: "evt-1", recipientType: "abstracts" as const, organizerName: "Org", organizerEmail: "org@x.com", organizationId: "org-1", triggeredByUserId: "u1" };
const sentVars = (i = 0) => JSON.parse(sendEmail.mock.calls[i][0].htmlContent) as Record<string, unknown>;

const TG_BLOCK = { html: '<a href="https://x/e/hemnet/travel-grant/tok1">Apply for Travel Grant</a>', text: "Apply: https://x/e/hemnet/travel-grant/tok1" };
const renderedTemplate = (i = 0) => vi.mocked(renderAndWrap).mock.calls[i][0] as { htmlContent: string; textContent: string };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued "once" values and set implementations: a saved
  // template one test queued must not be the next test's template.
  vi.mocked(getEventTemplate).mockReset().mockResolvedValue(null);
  vi.mocked(loadActiveEventTemplateRow).mockReset();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  resolveTravelGrantBlock.mockResolvedValue({ html: "", text: "" });
});

describe("the reviewers audience is the event's pool, whatever each account's role", () => {
  it("does not filter the pool by role, or a speaker who reviews would miss the email", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: { reviewerUserIds: ["u1", "u2"] } });
    mockDb.user.findMany.mockResolvedValue([]);
    await executeBulkEmail({ ...BASE, recipientType: "reviewers", emailType: "custom", customSubject: "S", customMessage: "M" } as Parameters<typeof executeBulkEmail>[0]).catch(() => null);
    expect(mockDb.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["u1", "u2"] } });
  });
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

describe("abstract-confirmation carries the travel-grant offer (Sep 9, 2026)", () => {
  // Two MEHF bulk resends on Sep 8 reached five eligible authors with no link,
  // because the bulk path hard-coded the block to "". The resend now goes
  // through the SAME resolver as the automatic confirmation.
  // MUTATION: restore `vars.travelGrantBlock = ""` for the confirmation type,
  // the first two tests fail; drop the tplForSend append, the second fails.
  it("resolves the block per abstract from the author's country and the event's settings, and appends the token to a template that lacks it", async () => {
    resolveTravelGrantBlock.mockResolvedValue(TG_BLOCK);
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1", serialId: 7 })]);

    const r = await executeBulkEmail({ ...BASE, emailType: "abstract-confirmation" });
    expect(r.successCount).toBe(1);
    expect(resolveTravelGrantBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-1",
        organizationId: "org-1",
        eventSlug: "hemnet",
        speakerId: "spk-1",
        speakerCountry: "Egypt",
        messageHtml: "<p>We help with flights.</p>",
        settings: EVENT.settings,
        abstractId: "abs-1",
      }),
    );
    expect(sentVars(0)).toMatchObject({ travelGrantBlock: TG_BLOCK.html, travelGrantBlockText: TG_BLOCK.text });
    // The saved-template trap: the default fixture has no token, so it is
    // appended rather than assumed, once, in both parts.
    const tpl = renderedTemplate();
    expect(tpl.htmlContent.match(/\{\{travelGrantBlock\}\}/g)).toHaveLength(1);
    expect(tpl.textContent.match(/\{\{travelGrantBlockText\}\}/g)).toHaveLength(1);
    expect(tpl.htmlContent).toContain("<p>x</p>");
  });

  it("does not append the token when the template already places it", async () => {
    const { getEventTemplate } = await import("@/lib/email");
    vi.mocked(getEventTemplate).mockResolvedValueOnce({
      slug: "abstract-submission-confirmation", subject: "S", htmlContent: "<p>Hi</p>{{travelGrantBlock}}", textContent: "Hi\n{{travelGrantBlockText}}",
    } as never);
    resolveTravelGrantBlock.mockResolvedValue(TG_BLOCK);
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({})]);

    await executeBulkEmail({ ...BASE, emailType: "abstract-confirmation" });
    const tpl = renderedTemplate();
    expect(tpl.htmlContent.match(/\{\{travelGrantBlock\}\}/g)).toHaveLength(1);
    expect(tpl.textContent.match(/\{\{travelGrantBlockText\}\}/g)).toHaveLength(1);
  });

  it("leaves an ineligible author's template byte-identical: no block, no appended token", async () => {
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({})]);
    await executeBulkEmail({ ...BASE, emailType: "abstract-confirmation" });
    expect(sentVars(0)).toMatchObject({ travelGrantBlock: "", travelGrantBlockText: "" });
    expect(renderedTemplate().htmlContent).toBe("<p>x</p>");
    expect(renderedTemplate().textContent).toBe("x");
  });

  it("the decision email never resolves the offer (parked: ROADMAP travel grant follow-ups)", async () => {
    resolveTravelGrantBlock.mockResolvedValue(TG_BLOCK);
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ status: "ACCEPTED" })]);
    await executeBulkEmail({ ...BASE, emailType: "abstract-decision" });
    expect(resolveTravelGrantBlock).not.toHaveBeenCalled();
    expect(sentVars(0)).toMatchObject({ travelGrantBlock: "" });
    expect(renderedTemplate().htmlContent).toBe("<p>x</p>");
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
    // A rejected abstract reads NOT ACCEPTED to its author (owner, Nov 20, 2026; abstract-status-label.ts).
    expect(sentVars(1)).toMatchObject({ statusHeading: "Abstract Decision", newStatus: "NOT ACCEPTED", reviewNotes: "" });
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

  it("dedupes authors case-insensitively, so the server count and the send agree on a legacy mixed-case row", async () => {
    mockDb.abstract.findMany.mockResolvedValue([
      abstractRow({ id: "abs-1", speaker: { ...SPEAKER, email: "jane@x.com" } }),
      abstractRow({ id: "abs-2", speaker: { ...SPEAKER, email: "JANE@x.com" } }),
    ]);
    const r = await executeBulkEmail({ ...BASE, emailType: "custom", customSubject: "Hi", customMessage: "There" });
    expect(r.successCount).toBe(1);
  });

  it("a custom email keeps the per-author dedup and no status scope", async () => {
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1" }), abstractRow({ id: "abs-2" })]);
    const r = await executeBulkEmail({ ...BASE, emailType: "custom", customSubject: "Hi", customMessage: "There" });
    expect(r.successCount).toBe(1);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).not.toHaveProperty("status");
  });
});

describe("a saved template sent to abstract authors (Nov 20, 2026)", () => {
  // An organiser's own "Abstract Not Accepted" template named the abstract's
  // number, title and status. It went once per AUTHOR with none of them
  // filled, so the dialog previewed the built-in sample ("A-007, ACCEPTED")
  // and the send was refused for unresolved tokens.
  // MUTATION: make abstractSendIsPerAbstract answer false for "template" and
  // the first test sends one email with no abstractNumber.
  const NOT_ACCEPTED = {
    slug: "abstract-not-accepted",
    subject: "{{abstractNumber}}: {{newStatus}}",
    htmlContent: "<p>Dear {{title}} {{lastName}}, {{abstractTitle}} is {{newStatus}}.</p>",
    textContent: "",
  };
  const useTemplate = (tpl: typeof NOT_ACCEPTED) => {
    vi.mocked(loadActiveEventTemplateRow).mockResolvedValue(tpl);
    vi.mocked(getEventTemplate).mockResolvedValueOnce(tpl as never);
  };
  const SEND = { ...BASE, emailType: "template" as const, filters: { templateSlug: "abstract-not-accepted", status: "REJECTED" } };

  it("goes once per abstract, each with its own number, title and current status, when the template names them", async () => {
    useTemplate(NOT_ACCEPTED);
    mockDb.abstract.findMany.mockResolvedValue([
      abstractRow({ id: "abs-1", serialId: 4, title: "HF in women", status: "REJECTED" }),
      abstractRow({ id: "abs-2", serialId: 9, title: "Anaemia audit", status: "REJECTED" }),
    ]);
    const r = await executeBulkEmail(SEND);
    expect(r.successCount).toBe(2);
    expect(sentVars(0)).toMatchObject({ abstractNumber: "A-004", abstractTitle: "HF in women", newStatus: "NOT ACCEPTED", title: "Dr." });
    expect(sentVars(1)).toMatchObject({ abstractNumber: "A-009", abstractTitle: "Anaemia audit", newStatus: "NOT ACCEPTED" });
    // The organiser's status filter, above a floor: a per-abstract template never reaches a draft or a withdrawal.
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toEqual({
      eventId: "evt-1", status: "REJECTED", AND: [{ status: { notIn: ["DRAFT", "WITHDRAWN"] } }],
    });
    expect(resolveTravelGrantBlock).not.toHaveBeenCalled();
  });

  // Review of c332aea6. MUTATION: drop the floor from abstractRecipientWhere and
  // the where loses its AND; replace the status instead of AND-ing and an
  // explicit DRAFT would widen to every non-draft.
  it("with no status chosen it still leaves drafts and withdrawn abstracts out, and an explicit DRAFT matches nothing rather than widening", async () => {
    useTemplate(NOT_ACCEPTED);
    mockDb.abstract.findMany.mockResolvedValue([]);
    await executeBulkEmail({ ...SEND, filters: { templateSlug: "abstract-not-accepted" } }).catch(() => null);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toEqual({ eventId: "evt-1", AND: [{ status: { notIn: ["DRAFT", "WITHDRAWN"] } }] });

    useTemplate(NOT_ACCEPTED);
    await executeBulkEmail({ ...SEND, filters: { templateSlug: "abstract-not-accepted", status: "DRAFT" } }).catch(() => null);
    expect(mockDb.abstract.findMany.mock.calls[1][0].where).toEqual({
      eventId: "evt-1", status: "DRAFT", AND: [{ status: { notIn: ["DRAFT", "WITHDRAWN"] } }],
    });
  });

  it("a token only in the template's plain-text part does not change who is emailed: once per author, as before", async () => {
    useTemplate({ ...NOT_ACCEPTED, subject: "News", htmlContent: "<p>Dear {{lastName}}</p>", textContent: "About {{abstractTitle}}" });
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1" }), abstractRow({ id: "abs-2" })]);
    const r = await executeBulkEmail(SEND);
    expect(r.successCount).toBe(1);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toEqual({ eventId: "evt-1", status: "REJECTED" });
  });

  it("stays once per author when the template names nothing of one abstract", async () => {
    useTemplate({ ...NOT_ACCEPTED, subject: "News", htmlContent: "<p>Dear {{title}} {{lastName}}, the programme is out.</p>" });
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({ id: "abs-1" }), abstractRow({ id: "abs-2" })]);
    const r = await executeBulkEmail(SEND);
    expect(r.successCount).toBe(1);
    expect(sentVars(0)).not.toHaveProperty("abstractNumber");
    // The author's own name is filled per author too; it was refused before.
    expect(sentVars(0)).toMatchObject({ authorName: "Dr. Jane Doe" });
    // No floor on a per-author send: it is as it was.
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toEqual({ eventId: "evt-1", status: "REJECTED" });
  });
});

describe("ABSTRACT_OWN_TOKENS is what the builders fill", () => {
  // The rule reads the template's tokens against this list; a token a builder
  // gains and the list lacks would be filled per abstract but sent per author.
  it("names every token of the two builders except the person's own", () => {
    const person = new Set(["title", "firstName", "lastName", "authorName"]);
    const built = [
      ...Object.keys(buildAbstractConfirmationVars({ abstractTitle: "t", serialId: 1, presentationTypeName: "Oral", themeName: "x", coAuthors: null, speaker: SPEAKER })),
      ...Object.keys(buildAbstractDecisionVars({ status: "ACCEPTED", reviewNotes: null, reviewScore: null })),
    ].filter((k) => !person.has(k));
    expect([...ABSTRACT_OWN_TOKENS].sort()).toEqual([...new Set(built)].sort());
  });
});

describe("previewAbstractEmailVars: the dialog's Preview is the first email the send would produce", () => {
  const ASK = { eventId: "evt-1", emailType: "abstract-decision", templateTexts: [] };

  it("reads the send's own audience, lowest abstract number first, and answers that abstract's own decision", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(abstractRow({ id: "abs-4", serialId: 4, title: "HF in women", status: "REJECTED" }));
    const out = await previewAbstractEmailVars({ ...ASK, recipientIds: ["abs-4", "abs-9"] });
    expect(mockDb.abstract.findFirst.mock.calls[0][0]).toMatchObject({
      where: { eventId: "evt-1", id: { in: ["abs-4", "abs-9"] }, status: { in: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"] } },
      orderBy: [{ serialId: "asc" }, { createdAt: "asc" }],
    });
    expect(out?.shownFor).toBe("abstract A-004");
    expect(out?.perAbstract).toBe(true);
    expect(out?.vars).toMatchObject({
      abstractNumber: "A-004", abstractTitle: "HF in women", newStatus: "NOT ACCEPTED", statusHeading: "Abstract Decision",
      title: "Dr.", firstName: "Jane", lastName: "Doe",
    });
  });

  it("a saved template that names an abstract's tokens previews one abstract; one that does not previews the author only", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(abstractRow({ serialId: 4, status: "REJECTED" }));
    const per = await previewAbstractEmailVars({ ...ASK, emailType: "template", templateTexts: ["{{abstractNumber}}", "<p>{{newStatus}}</p>"] });
    expect(per?.vars).toMatchObject({ abstractNumber: "A-004", newStatus: "NOT ACCEPTED" });
    const author = await previewAbstractEmailVars({ ...ASK, emailType: "template", templateTexts: ["News", "<p>{{lastName}}</p>"] });
    expect(author?.shownFor).toBe("Dr. Jane Doe");
    expect(author?.perAbstract).toBe(false);
    expect(author?.vars).not.toHaveProperty("abstractNumber");
    expect(author?.vars).toMatchObject({ lastName: "Doe", authorName: "Dr. Jane Doe" });
    // The per-abstract template read above the floor; the per-author one did not.
    expect(mockDb.abstract.findFirst.mock.calls[0][0].where).toHaveProperty("AND");
    expect(mockDb.abstract.findFirst.mock.calls[1][0].where).not.toHaveProperty("AND");
  });

  it("answers null, so the samples stand, for an empty audience or a status the type cannot send", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    expect(await previewAbstractEmailVars(ASK)).toBeNull();
    mockDb.abstract.findFirst.mockClear();
    expect(await previewAbstractEmailVars({ ...ASK, status: "DRAFT" })).toBeNull();
    expect(mockDb.abstract.findFirst).not.toHaveBeenCalled();
  });
});

describe("the presenter agreement tokens on a send to abstract authors (Sep 25, 2026)", () => {
  it("attaches the AUTHOR's presenter PDF and fills their accept link, keyed on the speaker, not the abstract", async () => {
    const { getDefaultTemplate } = await import("@/lib/email");
    vi.mocked(getDefaultTemplate).mockReturnValue({ slug: "abstract-confirmation", name: "n", subject: "S", htmlContent: "<p>{{presenterAgreementLink}}</p>{{presenterAgreementAttachment}}", textContent: "x" } as never);
    presenterMint.mockResolvedValue("https://x/e/hemnet/presenter-agreement?token=t1");
    presenterPdf.mockResolvedValue({ filename: "presenter-agreement-hemnet-doe.pdf", buffer: Buffer.from("p") });
    mockDb.abstract.findMany.mockResolvedValue([abstractRow({})]);
    await executeBulkEmail({ ...BASE, emailType: "abstract-confirmation" });
    expect(presenterMint).toHaveBeenCalledWith("spk-1", "hemnet", { rotate: false });
    expect(mockDb.abstract.findMany.mock.calls[0][0].select.speaker.select).toMatchObject({ presenterAgreementAcceptedAt: true });
    expect(presenterPdf).toHaveBeenCalledWith({ eventId: "evt-1", speakerId: "spk-1" });
    expect(sentVars().presenterAgreementLink).toBe("https://x/e/hemnet/presenter-agreement?token=t1");
    expect((sendEmail.mock.calls[0][0].attachments as { name: string }[]).map((a) => a.name)).toContain("presenter-agreement-hemnet-doe.pdf");
  });
});
