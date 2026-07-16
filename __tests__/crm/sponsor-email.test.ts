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
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  renderAndWrap: vi.fn(() => ({ subject: "s", htmlContent: "<p>h</p>", textContent: "t" })),
  brandingFrom: vi.fn(() => undefined),
  brandingCc: vi.fn(() => undefined),
}));

vi.mock("@/crm/lib/crm-activity", () => ({
  recordCrmActivity: vi.fn(() => Promise.resolve({})),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { collectSponsorRecipients, narrowToSelected } from "@/crm/lib/sponsor-recipients";
import type { RawDealForRecipients } from "@/crm/lib/sponsor-recipients";
import { resolveSponsorRecipients, sendSponsorProspectus, sendDealEmail } from "@/crm/services/sponsor-email-service";
import { CRM_EMAIL_TEMPLATES } from "@/crm/lib/crm-email-templates";

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

// ── built-in templates ─────────────────────────────────────────────────────────────

describe("CRM_EMAIL_TEMPLATES", () => {
  it("is a small set with subject + body and only the supported tokens", () => {
    expect(CRM_EMAIL_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    expect(CRM_EMAIL_TEMPLATES.length).toBeLessThanOrEqual(3);
    const allowed = new Set(["firstName", "lastName", "companyName", "eventName"]);
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
