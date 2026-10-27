/**
 * Sponsor-prospectus email.
 *
 * The correctness that matters is the AUDIENCE — the CRM's narrow-never-widen rule:
 *   1. recipients are deduped across an event's deals (one email per person),
 *   2. archived / email-less contacts are dropped (and counted for the preview),
 *   3. a caller's selection can only REMOVE from the resolved set, never ADD — an
 *      invented contactId can't smuggle a stranger onto the send.
 * Plus the send loop isolates a per-recipient failure and only records CRM history
 * on a genuine success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn() },
    crmEmailThread: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  renderAndWrap: vi.fn(() => ({ subject: "s", htmlContent: "<p>h</p>", textContent: "t" })),
  brandingFrom: vi.fn(() => undefined),
  brandingCc: vi.fn(() => undefined),
  sesRfcMessageId: vi.fn((id: string) => `<${id}@ap-south-1.amazonses.com>`),
}));

vi.mock("@/crm/lib/crm-activity", () => ({
  recordCrmActivity: vi.fn(() => Promise.resolve({})),
}));

// Inbox threading is bookkeeping AFTER the send — covered by its own suite
// (crm-email-threads.test.ts); mocked here so the audience tests stay focused.
vi.mock("@/crm/services/crm-email-thread-service", () => ({
  mintReplyToken: vi.fn(() => "tok-test"),
  crmReplyAddress: vi.fn(() => null),
  recordOutboundEmail: vi.fn(() => Promise.resolve()),
  extendThreadToken: vi.fn(() => Promise.resolve(true)),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { collectSponsorRecipients, narrowToSelected } from "@/crm/lib/sponsor-recipients";
import type { RawDealForRecipients } from "@/crm/lib/sponsor-recipients";
import {
  resolveSponsorRecipients,
  sendSponsorProspectus,
  sendDealEmail,
  crmSenderFrom,
  previewCrmEmail,
  resolveThreadRecipients,
  sendThreadReply,
} from "@/crm/services/sponsor-email-service";
import { extendThreadToken, recordOutboundEmail } from "@/crm/services/crm-email-thread-service";
import { renderAndWrap } from "@/lib/email";
import { CRM_EMAIL_TEMPLATES } from "@/crm/lib/crm-email-templates";
import { CRM_EMAIL_TOKEN_KEYS } from "@/crm/lib/crm-email-tokens";

// ── fixtures ────────────────────────────────────────────────────────────────────

function contact(over: Partial<RawDealForRecipients["contacts"][number]["crmContact"]> = {}) {
  return {
    crmContact: {
      id: over.id ?? "c1",
      firstName: over.firstName ?? "Jane",
      lastName: over.lastName ?? "Doe",
      email: over.email ?? "jane@abbott.com",
      emailKey: over.emailKey ?? (over.email ?? "jane@abbott.com").toLowerCase(),
      archivedAt: over.archivedAt ?? null,
      // "company" in over lets a test pass an explicit null (distinct from "omitted").
      company: "company" in over ? (over.company ?? null) : { name: "Abbott" },
    },
  };
}

function deal(contacts: RawDealForRecipients["contacts"], company: { name: string } | null = { name: "Abbott" }): RawDealForRecipients {
  return { company, contacts };
}

// ── collectSponsorRecipients ─────────────────────────────────────────────────────

describe("collectSponsorRecipients", () => {
  it("dedupes a person across deals by emailKey and counts the overlap", () => {
    const deals = [
      deal([contact({ id: "c1", emailKey: "jane@abbott.com" })]),
      deal([contact({ id: "c1b", email: "Jane@Abbott.com", emailKey: "jane@abbott.com" })]),
    ];
    const { recipients } = collectSponsorRecipients(deals);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].dealCount).toBe(2);
    // first-seen wins for identity
    expect(recipients[0].crmContactId).toBe("c1");
  });

  it("skips archived + email-less contacts and counts each once", () => {
    const deals = [
      deal([
        contact({ id: "ok", email: "ok@x.com", emailKey: "ok@x.com" }),
        contact({ id: "arch", archivedAt: new Date(), email: "a@x.com", emailKey: "a@x.com" }),
        contact({ id: "noemail", email: "", emailKey: "" }),
      ]),
      // the archived contact reappears on a second deal — still one skip, not two
      deal([contact({ id: "arch", archivedAt: new Date(), email: "a@x.com", emailKey: "a@x.com" })]),
    ];
    const { recipients, skipped } = collectSponsorRecipients(deals);
    expect(recipients.map((r) => r.crmContactId)).toEqual(["ok"]);
    expect(skipped).toEqual({ noEmail: 1, archivedContacts: 1 });
  });

  it("falls back to the deal's company when the contact has none", () => {
    const deals = [deal([contact({ id: "c1", company: null })], { name: "Pfizer" })];
    const { recipients } = collectSponsorRecipients(deals);
    expect(recipients[0].companyName).toBe("Pfizer");
  });

  it("sorts by company then name", () => {
    const deals = [
      deal([contact({ id: "z", firstName: "A", lastName: "Zed", email: "z@z.com", emailKey: "z@z.com", company: { name: "Zeta" } })]),
      deal([contact({ id: "a", firstName: "B", lastName: "Ay", email: "a@a.com", emailKey: "a@a.com", company: { name: "Alpha" } })]),
    ];
    const { recipients } = collectSponsorRecipients(deals);
    expect(recipients.map((r) => r.companyName)).toEqual(["Alpha", "Zeta"]);
  });
});

// ── narrowToSelected (narrow, never widen) ───────────────────────────────────────

describe("narrowToSelected", () => {
  const recipients = [
    { crmContactId: "a", firstName: "A", lastName: "A", email: "a@a.com", companyName: null, dealCount: 1 },
    { crmContactId: "b", firstName: "B", lastName: "B", email: "b@b.com", companyName: null, dealCount: 1 },
  ];

  it("returns everyone when no selection is given", () => {
    expect(narrowToSelected(recipients, undefined).map((r) => r.crmContactId)).toEqual(["a", "b"]);
  });

  it("keeps only the intersection", () => {
    expect(narrowToSelected(recipients, ["a"]).map((r) => r.crmContactId)).toEqual(["a"]);
  });

  it("never widens — an id outside the resolved set is ignored", () => {
    expect(narrowToSelected(recipients, ["a", "stranger"]).map((r) => r.crmContactId)).toEqual(["a"]);
  });
});

// ── service ──────────────────────────────────────────────────────────────────────

const EVENT_ROW = {
  id: "ev1",
  name: "BRIDGES 2026",
  startDate: new Date("2026-11-20T05:00:00Z"),
  endDate: new Date("2026-11-21T12:00:00Z"),
  timezone: "Asia/Dubai",
  venue: "Grand Hyatt",
  city: "Dubai",
  country: "UAE",
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  emailFromAddress: null,
  emailFromName: null,
  emailCcAddresses: [],
};

function mockDeals(deals: RawDealForRecipients[]) {
  vi.mocked(db.event.findFirst).mockResolvedValue(EVENT_ROW as never);
  vi.mocked(db.crmDeal.findMany).mockResolvedValue(deals as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
}

const SEND = {
  organizationId: "org1",
  eventId: "ev1",
  subject: "Sponsor us",
  message: "<p>Hi {{firstName}} from {{companyName}}</p>",
  actorUserId: "u1",
  source: "rest" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordCrmActivity).mockResolvedValue({} as never);
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
});

describe("resolveSponsorRecipients", () => {
  it("404s an event outside the org", async () => {
    vi.mocked(db.event.findFirst).mockResolvedValue(null as never);
    const r = await resolveSponsorRecipients({ organizationId: "org1", eventId: "ev1" });
    expect(r).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
  });
});

describe("sendSponsorProspectus", () => {
  it("sends one email per resolved sponsor and records CRM history on success", async () => {
    mockDeals([
      deal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]),
      deal([contact({ id: "c2", email: "b@b.com", emailKey: "b@b.com" })]),
    ]);
    const res = await sendSponsorProspectus(SEND);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ total: 2, successCount: 2, failureCount: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(recordCrmActivity).toHaveBeenCalledTimes(2);
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "CONTACT", action: "PROSPECTUS_SENT" }),
    );
  });

  it("isolates a per-recipient failure and does NOT record history for it", async () => {
    mockDeals([
      deal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]),
      deal([contact({ id: "c2", email: "b@b.com", emailKey: "b@b.com" })]),
    ]);
    vi.mocked(sendEmail)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: false, error: "bounced" } as never);
    const res = await sendSponsorProspectus(SEND);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ total: 2, successCount: 1, failureCount: 1 });
    expect(res.errors).toHaveLength(1);
    expect(recordCrmActivity).toHaveBeenCalledTimes(1);
  });

  it("never widens: a selection of a stranger id emails nobody real it didn't resolve", async () => {
    mockDeals([deal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })])]);
    const res = await sendSponsorProspectus({ ...SEND, contactIds: ["c1", "stranger"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty audience", async () => {
    mockDeals([]);
    const res = await sendSponsorProspectus(SEND);
    expect(res).toMatchObject({ ok: false, code: "NO_RECIPIENTS" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("validates subject, message and attachments", async () => {
    mockDeals([deal([contact()])]);
    expect(await sendSponsorProspectus({ ...SEND, subject: "  " })).toMatchObject({ code: "SUBJECT_REQUIRED" });
    expect(await sendSponsorProspectus({ ...SEND, message: "  " })).toMatchObject({ code: "BODY_REQUIRED" });
    expect(
      await sendSponsorProspectus({
        ...SEND,
        attachments: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, content: "AAAA" })),
      }),
    ).toMatchObject({ code: "TOO_MANY_ATTACHMENTS" });
    expect(
      await sendSponsorProspectus({
        ...SEND,
        attachments: [{ name: "big.pdf", content: "A".repeat(15 * 1024 * 1024) }],
      }),
    ).toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses non-document attachment types on the external blast (L12)", async () => {
    mockDeals([deal([contact()])]);
    expect(
      await sendSponsorProspectus({
        ...SEND,
        attachments: [{ name: "payload.html", content: "AAAA", contentType: "text/html" }],
      }),
    ).toMatchObject({ code: "ATTACHMENT_TYPE_NOT_ALLOWED" });
    expect(
      await sendSponsorProspectus({
        ...SEND,
        attachments: [{ name: "run.exe", content: "AAAA", contentType: "application/x-msdownload" }],
      }),
    ).toMatchObject({ code: "ATTACHMENT_TYPE_NOT_ALLOWED" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("accepts the prospectus PDF", async () => {
    mockDeals([deal([contact()])]);
    const res = await sendSponsorProspectus({
      ...SEND,
      attachments: [{ name: "prospectus.pdf", content: "AAAA", contentType: "application/pdf" }],
    });
    expect(res.ok).toBe(true);
  });
});

// ── per-deal send ─────────────────────────────────────────────────────────────────

function mockDeal(
  contacts: RawDealForRecipients["contacts"],
  event: { name: string } | null = { name: "BRIDGES 2026" },
) {
  vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
    id: "deal1",
    name: "Abbott — BRIDGES",
    company: { name: "Abbott" },
    contacts,
    event: event
      ? {
          name: event.name,
          startDate: new Date("2026-11-20T05:00:00Z"),
          endDate: new Date("2026-11-21T12:00:00Z"),
          timezone: "Asia/Dubai",
          venue: "Grand Hyatt",
          city: "Dubai",
          country: "UAE",
          emailHeaderImage: null,
          emailFooterImage: null,
          emailFooterHtml: null,
          emailFromAddress: null,
          emailFromName: null,
          emailCcAddresses: [],
        }
      : null,
  } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
}

const DEAL_SEND = {
  organizationId: "org1",
  dealId: "deal1",
  subject: "Following up",
  message: "<p>Hi {{firstName}}</p>",
  actorUserId: "u1",
  source: "rest" as const,
};

describe("sendDealEmail", () => {
  it("404s a deal outside the org / archived", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    expect(await sendDealEmail(DEAL_SEND)).toMatchObject({ ok: false, code: "DEAL_NOT_FOUND" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("emails the deal's contacts and records a deal-level summary + per-contact history", async () => {
    mockDeal([
      contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" }),
      contact({ id: "c2", email: "b@b.com", emailKey: "b@b.com" }),
    ]);
    const res = await sendDealEmail(DEAL_SEND);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ total: 2, successCount: 2, failureCount: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // 2 CONTACT rows (EMAIL_SENT) + 1 DEAL summary row (EMAIL_SENT)
    expect(recordCrmActivity).toHaveBeenCalledTimes(3);
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "DEAL", entityId: "deal1", action: "EMAIL_SENT" }),
    );
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "CONTACT", action: "EMAIL_SENT" }),
    );
  });

  it("never widens — a stranger id in the selection emails nobody it didn't resolve", async () => {
    mockDeal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]);
    const res = await sendDealEmail({ ...DEAL_SEND, contactIds: ["c1", "stranger"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends for a deal with no linked event (default branding, empty {{eventName}})", async () => {
    mockDeal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })], null);
    const res = await sendDealEmail(DEAL_SEND);
    expect(res.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not record a deal summary when everyone failed", async () => {
    mockDeal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]);
    vi.mocked(sendEmail).mockResolvedValue({ success: false, error: "bounced" } as never);
    const res = await sendDealEmail(DEAL_SEND);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.successCount).toBe(0);
    expect(recordCrmActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "DEAL" }),
    );
  });
});

describe("CC / BCC + copy-to-sender", () => {
  const lastSend = () => vi.mocked(sendEmail).mock.calls.at(-1)?.[0];

  function mockDealWithSender(email: string | null) {
    mockDeal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null, email } as never);
  }

  it("auto-BCCs the sender when copyToSender is on (the 'see it in my Outlook' copy)", async () => {
    mockDealWithSender("rep@mmg.com");
    const res = await sendDealEmail({ ...DEAL_SEND, copyToSender: true });
    expect(res.ok).toBe(true);
    expect(lastSend()?.bcc).toEqual([{ email: "rep@mmg.com" }]);
  });

  it("does NOT BCC the sender when copyToSender is off", async () => {
    mockDealWithSender("rep@mmg.com");
    await sendDealEmail({ ...DEAL_SEND, copyToSender: false });
    // No manual bcc + no sender copy → bcc omitted entirely.
    expect(lastSend()?.bcc).toBeUndefined();
  });

  it("merges manual CC + BCC and lowercases/dedupes; sender copy joins the BCC list", async () => {
    mockDealWithSender("Rep@MMG.com");
    await sendDealEmail({
      ...DEAL_SEND,
      cc: ["Manager@MMG.com", "manager@mmg.com"], // dup, mixed case
      bcc: ["audit@mmg.com"],
      copyToSender: true,
    });
    const call = lastSend();
    expect(call?.cc).toEqual([{ email: "manager@mmg.com" }]); // deduped + lowercased
    expect(call?.bcc).toEqual([{ email: "audit@mmg.com" }, { email: "rep@mmg.com" }]);
  });

  it("omits the sender copy when the acting user has no email on file", async () => {
    mockDealWithSender(null);
    await sendDealEmail({ ...DEAL_SEND, copyToSender: true });
    expect(lastSend()?.bcc).toBeUndefined();
  });

  it("applies CC/BCC per recipient (each send carries them) on a multi-contact deal", async () => {
    mockDeal([
      contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" }),
      contact({ id: "c2", email: "b@b.com", emailKey: "b@b.com" }),
    ]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null, email: "rep@mmg.com" } as never);
    await sendDealEmail({ ...DEAL_SEND, copyToSender: true });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(sendEmail).mock.calls) {
      expect(call[0].bcc).toEqual([{ email: "rep@mmg.com" }]);
    }
  });
});

// ── preview ─────────────────────────────────────────────────────────────────────

describe("previewCrmEmail", () => {
  const PREVIEW = {
    organizationId: "org1",
    target: { kind: "deal" as const, id: "deal1" },
    subject: "Join {{eventName}}",
    message: "<p>{{firstName}}, see you at {{eventVenue}} on {{eventDates}}</p>",
    actorUserId: "u1",
  };

  it("renders for the chosen recipient with the event's tokens, and sends nothing", async () => {
    mockDeal([
      contact({ id: "c1", firstName: "Ann", email: "a@a.com", emailKey: "a@a.com" }),
      contact({ id: "c2", firstName: "Bob", email: "b@b.com", emailKey: "b@b.com" }),
    ]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: "<p>Sohail</p>", email: "s@x.com" } as never);
    const res = await previewCrmEmail({ ...PREVIEW, contactId: "c2" });
    expect(res).toMatchObject({ ok: true, recipient: { crmContactId: "c2", email: "b@b.com" } });
    const [, vars] = vi.mocked(renderAndWrap).mock.calls[0]!;
    expect(vars).toMatchObject({ firstName: "Bob", eventVenue: "Grand Hyatt", signature: "<p>Sohail</p>" });
    expect(String(vars.message)).toContain("Bob, see you at Grand Hyatt on November 20");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordCrmActivity).not.toHaveBeenCalled();
  });

  it("falls back to the first recipient for an id it did not resolve (no peeking at other contacts)", async () => {
    mockDeal([contact({ id: "c1", firstName: "Ann", email: "a@a.com", emailKey: "a@a.com" })]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
    const res = await previewCrmEmail({ ...PREVIEW, contactId: "stranger" });
    expect(res).toMatchObject({ ok: true, recipient: { crmContactId: "c1" } });
  });

  it("uses a sample person when the deal has nobody to email yet", async () => {
    mockDeal([]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
    const res = await previewCrmEmail(PREVIEW);
    expect(res).toMatchObject({ ok: true, recipient: null });
    expect(vi.mocked(renderAndWrap).mock.calls[0]![1]).toMatchObject({ firstName: "Alex" });
  });

  it("previews an event-wide send with that event's tokens", async () => {
    mockDeals([deal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })])]);
    const res = await previewCrmEmail({ ...PREVIEW, target: { kind: "event", id: "ev1" } });
    expect(res.ok).toBe(true);
    expect(vi.mocked(renderAndWrap).mock.calls[0]![1]).toMatchObject({ eventName: "BRIDGES 2026", eventCity: "Dubai" });
  });

  it("previews the sample person when asked, never a contact who will not get the email", async () => {
    mockDeal([contact({ id: "c1", firstName: "Ann", email: "a@a.com", emailKey: "a@a.com" })]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
    const res = await previewCrmEmail({ ...PREVIEW, sample: true });
    expect(res).toMatchObject({ ok: true, recipient: null });
    expect(vi.mocked(renderAndWrap).mock.calls[0]![1]).toMatchObject({ firstName: "Alex" });
  });

  it("resolves a token the editor split with markup, as the event emails do", async () => {
    mockDeal([contact({ id: "c1", email: "a@a.com", emailKey: "a@a.com" })]);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
    await previewCrmEmail({ ...PREVIEW, message: "<p>At {{<strong>eventVenue</strong>}}</p>" });
    expect(String(vi.mocked(renderAndWrap).mock.calls[0]![1].message)).toBe("<p>At Grand Hyatt</p>");
  });

  it("renders the real email: subject tokens resolve and event values are escaped in the body", async () => {
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    vi.mocked(renderAndWrap).mockImplementationOnce(actual.renderAndWrap);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      id: "deal1",
      name: "Abbott",
      company: { name: "Abbott" },
      contacts: [contact({ id: "c1", firstName: "Ann", email: "a@a.com", emailKey: "a@a.com" })],
      event: {
        name: "BRIDGES 2026",
        startDate: new Date("2026-11-20T05:00:00Z"),
        endDate: new Date("2026-11-21T12:00:00Z"),
        timezone: "Asia/Dubai",
        venue: "Hyatt & <Co>",
        city: "Dubai",
        country: "UAE",
        emailHeaderImage: null,
        emailFooterImage: null,
        emailFooterHtml: null,
        emailFromAddress: null,
        emailFromName: null,
        emailCcAddresses: [],
      },
    } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null } as never);
    const res = await previewCrmEmail({ ...PREVIEW, subject: "Join {{eventName}} on {{eventDates}}" });
    if (!res.ok) throw new Error(res.message);
    expect(res.subject).toMatch(/^Join BRIDGES 2026 on November 20\s*[–-]\s*21, 2026$/);
    expect(res.html).toContain("Hyatt &amp; &lt;Co&gt;");
    expect(res.html).not.toContain("<Co>");
  });

  it("404s a deal outside the org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    expect(await previewCrmEmail(PREVIEW)).toMatchObject({ ok: false, code: "DEAL_NOT_FOUND" });
  });
});

// ── built-in templates ─────────────────────────────────────────────────────────────

describe("CRM_EMAIL_TEMPLATES", () => {
  it("is a small set with subject + body and only the supported tokens", () => {
    expect(CRM_EMAIL_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    expect(CRM_EMAIL_TEMPLATES.length).toBeLessThanOrEqual(3);
    const allowed = new Set<string>(CRM_EMAIL_TOKEN_KEYS);
    for (const t of CRM_EMAIL_TEMPLATES) {
      expect(t.subject.trim()).not.toBe("");
      expect(t.body.trim()).not.toBe("");
      // Bodies must NOT repeat the greeting — the pipeline bakes "Dear {{firstName}}" in.
      expect(t.body.toLowerCase()).not.toContain("dear {{firstname}}");
      const tokens = [
        ...t.subject.matchAll(/\{\{\s*(\w+)\s*\}\}/g),
        ...t.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g),
      ].map((m) => m[1]);
      for (const tok of tokens) expect(allowed.has(tok)).toBe(true);
    }
  });
});

describe("crmSenderFrom — CRM emails come from the partnerships identity, not the platform default", () => {
  const saved = { addr: process.env.CRM_EMAIL_FROM_ADDRESS, name: process.env.CRM_EMAIL_FROM_NAME };
  afterEach(() => {
    if (saved.addr === undefined) delete process.env.CRM_EMAIL_FROM_ADDRESS;
    else process.env.CRM_EMAIL_FROM_ADDRESS = saved.addr;
    if (saved.name === undefined) delete process.env.CRM_EMAIL_FROM_NAME;
    else process.env.CRM_EMAIL_FROM_NAME = saved.name;
  });

  it("when CRM_EMAIL_FROM_ADDRESS is set, that identity wins for every CRM send", () => {
    process.env.CRM_EMAIL_FROM_ADDRESS = "partnerships@meetingmindsdubai.com";
    process.env.CRM_EMAIL_FROM_NAME = "Partnerships";
    expect(crmSenderFrom()).toEqual({ email: "partnerships@meetingmindsdubai.com", name: "Partnerships" });
    // Even a deal's event branding does not override the CRM sender.
    expect(crmSenderFrom({ emailFromAddress: "events@x.com", emailFromName: "Events", emailCcAddresses: [] })).toEqual({
      email: "partnerships@meetingmindsdubai.com",
      name: "Partnerships",
    });
  });

  it("unset → falls back to the event/global sender (brandingFrom, mocked undefined here)", () => {
    delete process.env.CRM_EMAIL_FROM_ADDRESS;
    delete process.env.CRM_EMAIL_FROM_NAME;
    expect(crmSenderFrom()).toBeUndefined();
  });
});

// ── greeting + signature (Oct 27, 2026) ─────────────────────────────────────────

describe("rendering the greeting and the signature", () => {
  // The renderer normalizes <br/> to <br>.
  const SIG = /Sohail Qureshi<br\s*\/?>Partnerships/g;
  async function render(message: string, signature: string | null = "<p>Sohail Qureshi<br/>Partnerships</p>") {
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    vi.mocked(renderAndWrap).mockImplementationOnce(actual.renderAndWrap);
    mockDeal([contact({ id: "c1", firstName: "Saleh", email: "s@a.com", emailKey: "s@a.com" })]);
    vi.mocked(db.user.findUnique).mockResolvedValue({
      emailSignature: signature,
      email: "sohail@meetingmindsdubai.com",
      firstName: "Sohail",
      lastName: "Qureshi",
    } as never);
    const res = await previewCrmEmail({
      organizationId: "org1",
      target: { kind: "deal", id: "deal1" },
      subject: "Hello",
      message,
      actorUserId: "u1",
    });
    if (!res.ok) throw new Error(res.message);
    return res.html;
  }

  it("adds Dear {{firstName}} when the message has no greeting", async () => {
    const html = await render("<p>We would love to have you.</p>");
    expect(html.match(/Dear Saleh/g)).toHaveLength(1);
  });

  it("never doubles the greeting when the message opens with its own", async () => {
    const html = await render("<p>Dear Saleh,</p><p>We would love to have you.</p>");
    expect(html.match(/Dear Saleh/g)).toHaveLength(1);
  });

  it("appends the profile signature at the end when the message does not place it", async () => {
    const html = await render("<p>Thanks</p>");
    expect(html.match(SIG)).toHaveLength(1);
    expect(html.indexOf("Thanks")).toBeLessThan(html.search(SIG));
  });

  it("{{organizerSignature}} places the signature where written, once, unescaped", async () => {
    const html = await render("<p>Thanks</p>{{organizerSignature}}<p>P.S. see attached</p>");
    expect(html.match(SIG)).toHaveLength(1);
    expect(html.search(SIG)).toBeLessThan(html.indexOf("P.S. see attached"));
    expect(html).not.toContain("{{organizerSignature}}");
  });

  it("{{senderName}} and {{senderEmail}} come from the sender's profile", async () => {
    const html = await render("<p>Reach {{senderName}} at {{senderEmail}}</p>");
    expect(html).toContain("Reach Sohail Qureshi at sohail@meetingmindsdubai.com");
  });
});

// ── reply in a thread (the inbox, Oct 27, 2026) ─────────────────────────────────

describe("replying in an inbox thread", () => {
  const THREAD = {
    id: "t-1",
    subject: "Sponsorship",
    replyToken: "tok-thread",
    revokedAt: null,
    counterpartyEmail: "jane@abbott.com",
    crmContact: { id: "c1", firstName: "Jane", lastName: "Doe", archivedAt: null, company: { name: "Abbott" } },
    deal: {
      id: "deal1",
      event: {
        name: "BRIDGES 2026",
        startDate: new Date("2026-11-20T05:00:00Z"),
        endDate: new Date("2026-11-21T12:00:00Z"),
        timezone: "Asia/Dubai",
        venue: "Grand Hyatt",
        city: "Dubai",
        country: "UAE",
        emailHeaderImage: null,
        emailFooterImage: null,
        emailFooterHtml: null,
        emailFromAddress: null,
        emailFromName: null,
        emailCcAddresses: [],
      },
    },
    messages: [
      // Our first email, stored before Message-IDs were kept: only the SES id.
      { direction: "OUTBOUND", messageId: null, providerMessageId: "ses-1", unverifiedSender: false },
      { direction: "INBOUND", messageId: "<reply-1@outlook.com>", providerMessageId: "inbound/key", unverifiedSender: false },
      // A spoofed "reply": its id must never become what we thread onto.
      { direction: "INBOUND", messageId: "<spoof@evil.example>", providerMessageId: "inbound/k2", unverifiedSender: true },
    ],
  };
  const REPLY = {
    organizationId: "org1",
    threadId: "t-1",
    subject: "Re: Sponsorship",
    message: "<p>Thanks {{firstName}}</p>",
    actorUserId: "u1",
    source: "rest" as const,
  };

  beforeEach(() => {
    vi.mocked(extendThreadToken).mockResolvedValue(true);
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue(THREAD as never);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: null, email: "rep@mmg.com" } as never);
  });

  it("threads onto every message, rebuilding our old Message-IDs from the SES id", async () => {
    const r = await resolveThreadRecipients({ organizationId: "org1", threadId: "t-1" });
    if (!r.ok) throw new Error(r.message);
    expect(r.reply).toEqual({
      threadId: "t-1",
      replyToken: "tok-thread",
      threading: {
        inReplyTo: "<reply-1@outlook.com>",
        references: ["<ses-1@ap-south-1.amazonses.com>", "<reply-1@outlook.com>"],
      },
    });
    expect(r.recipients).toEqual([
      expect.objectContaining({ crmContactId: "c1", email: "jane@abbott.com", companyName: "Abbott" }),
    ]);
    expect(r.eventVars.eventVenue).toBe("Grand Hyatt");
    expect(db.crmEmailThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1", organizationId: "org1" } }),
    );
  });

  it("sends one email into the same thread with its headers, and records it on that thread", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "ses-2" } as never);
    const res = await sendThreadReply(REPLY);
    expect(res).toMatchObject({ ok: true, total: 1, successCount: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0]![0]).toMatchObject({
      to: [{ email: "jane@abbott.com" }],
      threading: { inReplyTo: "<reply-1@outlook.com>" },
    });
    expect(recordOutboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t-1",
        replyToken: "tok-thread",
        messageId: "<ses-2@ap-south-1.amazonses.com>",
        dealId: "deal1",
      }),
    );
    // The deal's history gets the summary, as a deal email does.
    expect(recordCrmActivity).toHaveBeenCalledWith(expect.objectContaining({ entityType: "DEAL", entityId: "deal1" }));
  });

  it("refuses a thread from another organisation, a closed one, and one whose contact is gone", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValueOnce(null as never);
    expect(await sendThreadReply(REPLY)).toMatchObject({ ok: false, code: "THREAD_NOT_FOUND" });
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValueOnce({ ...THREAD, revokedAt: new Date() } as never);
    expect(await sendThreadReply(REPLY)).toMatchObject({ ok: false, code: "THREAD_CLOSED" });
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValueOnce({ ...THREAD, crmContact: null } as never);
    expect(await sendThreadReply(REPLY)).toMatchObject({ ok: false, code: "CONTACT_GONE" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a thread with no deal replies without event branding or a deal summary", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue({ ...THREAD, deal: null } as never);
    vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "ses-3" } as never);
    const res = await sendThreadReply(REPLY);
    expect(res.ok).toBe(true);
    expect(recordCrmActivity).not.toHaveBeenCalledWith(expect.objectContaining({ entityType: "DEAL" }));
  });

  it("keeps the thread's reply token alive before sending, and refuses when it cannot", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "ses-4" } as never);
    await sendThreadReply(REPLY);
    expect(extendThreadToken).toHaveBeenCalledWith("org1", "t-1");

    vi.mocked(sendEmail).mockClear();
    vi.mocked(extendThreadToken).mockResolvedValue(false);
    expect(await sendThreadReply(REPLY)).toMatchObject({ ok: false, code: "THREAD_CLOSED" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("previews a reply for the thread's person", async () => {
    const res = await previewCrmEmail({
      organizationId: "org1",
      target: { kind: "thread", id: "t-1" },
      subject: "Re: Sponsorship",
      message: "<p>Hi</p>",
      actorUserId: "u1",
    });
    expect(res).toMatchObject({ ok: true, recipient: { crmContactId: "c1", email: "jane@abbott.com" } });
  });
});
