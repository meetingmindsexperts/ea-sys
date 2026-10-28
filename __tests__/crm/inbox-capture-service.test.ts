/**
 * Partnerships capture, the database half (Oct 27, 2026): account mapping by
 * domain only when unambiguous, a fresh person becomes a tagged contact,
 * machine mail never does, conversation matching, and History everywhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    crmCompany: { findMany: vi.fn() },
    crmContact: { findMany: vi.fn(), findFirst: vi.fn() },
    crmEmailMessage: { findFirst: vi.fn() },
    crmEmailThread: { findMany: vi.fn() },
    crmDealContact: { findMany: vi.fn() },
  },
}));
vi.mock("@/crm/lib/crm-activity", () => ({ recordCrmActivity: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/crm/services/crm-contact-service", () => ({
  findOrCreateCrmContact: vi.fn(),
  setCrmContactArchived: vi.fn(),
  contactEmailKey: (e: string) => e.trim().toLowerCase(),
}));

import { db } from "@/lib/db";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { findOrCreateCrmContact, setCrmContactArchived } from "@/crm/services/crm-contact-service";
import {
  findAccountForDomain,
  findCaptureThread,
  recordCaptureActivity,
  resolveCaptureContact,
  soleDealForContact,
} from "@/crm/services/inbox-capture-service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
  vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
  vi.mocked(db.crmContact.findFirst).mockResolvedValue(null as never);
});

describe("findAccountForDomain", () => {
  it("maps by the one account whose website names the domain", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "co-abbott", website: "https://www.abbott.com" }] as never);
    expect(await findAccountForDomain("org-1", "abbott.com")).toEqual({ id: "co-abbott", matchedBy: "website" });
  });

  it("ignores a lookalike website the database search returned (abbott.co vs abbott.com)", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "co-abbott", website: "abbott.com" }] as never);
    expect(await findAccountForDomain("org-1", "abbott.co")).toBeNull();
  });

  it("does not guess when two accounts share the domain", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([
      { id: "a", website: "abbott.com" },
      { id: "b", website: "www.abbott.com" },
    ] as never);
    expect(await findAccountForDomain("org-1", "abbott.com")).toBeNull();
    expect(db.crmContact.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the one account colleagues on the domain belong to", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([{ companyId: "co-gsk" }] as never);
    expect(await findAccountForDomain("org-1", "gsk.com")).toEqual({ id: "co-gsk", matchedBy: "colleague" });
  });

  it("never maps a consumer domain", async () => {
    expect(await findAccountForDomain("org-1", "gmail.com")).toBeNull();
    expect(db.crmCompany.findMany).not.toHaveBeenCalled();
  });
});

describe("resolveCaptureContact", () => {
  const args = { organizationId: "org-1", email: "jane@abbott.com", displayName: "Jane Doe", automated: false };

  it("uses an existing contact as is", async () => {
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "c-1", companyId: "co-1" } as never);
    expect(await resolveCaptureContact(args)).toEqual({ id: "c-1", companyId: "co-1", created: false });
    expect(findOrCreateCrmContact).not.toHaveBeenCalled();
  });

  it("an ARCHIVED contact who writes in is restored, with the reason in History (Oct 28, 2026)", async () => {
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "c-1", companyId: "co-1", archivedAt: new Date() } as never);
    vi.mocked(setCrmContactArchived).mockResolvedValue({ ok: true, crmContact: { id: "c-1" } } as never);
    expect(await resolveCaptureContact(args)).toEqual({ id: "c-1", companyId: "co-1", created: false });
    expect(setCrmContactArchived).toHaveBeenCalledWith(
      expect.objectContaining({ crmContactId: "c-1", archived: false, source: "inbox", reason: "Emailed the partnerships mailbox" }),
    );
    expect(findOrCreateCrmContact).not.toHaveBeenCalled();
  });

  it("if the restore fails the email is still filed, with no contact", async () => {
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "c-1", companyId: null, archivedAt: new Date() } as never);
    vi.mocked(setCrmContactArchived).mockResolvedValue({ ok: false, code: "UNKNOWN", message: "x" } as never);
    expect(await resolveCaptureContact(args)).toBeNull();
  });

  it("creates a fresh person as a tagged contact on the matched account, with History on the account", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "co-abbott", website: "abbott.com" }] as never);
    vi.mocked(findOrCreateCrmContact).mockResolvedValue({
      ok: true,
      created: true,
      crmContact: { id: "c-new", companyId: "co-abbott", firstName: "Jane", lastName: "Doe", emailKey: "jane@abbott.com" },
    } as never);
    expect(await resolveCaptureContact(args)).toEqual({ id: "c-new", companyId: "co-abbott", created: true });
    expect(findOrCreateCrmContact).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "inbox",
        userId: null,
        firstName: "Jane",
        lastName: "Doe",
        companyId: "co-abbott",
        tags: ["from-inbox"],
      }),
    );
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "COMPANY", entityId: "co-abbott", action: "CONTACT_ADDED" }),
    );
  });

  it("tags needs-account when no account is unambiguous", async () => {
    vi.mocked(findOrCreateCrmContact).mockResolvedValue({
      ok: true,
      created: true,
      crmContact: { id: "c-new", companyId: null, firstName: "Jane", lastName: "Doe", emailKey: "jane@abbott.com" },
    } as never);
    await resolveCaptureContact(args);
    expect(vi.mocked(findOrCreateCrmContact).mock.calls[0]![0].tags).toEqual(["from-inbox", "needs-account"]);
    expect(recordCrmActivity).not.toHaveBeenCalled();
  });

  it("never creates a contact for machine mail", async () => {
    expect(await resolveCaptureContact({ ...args, automated: true })).toBeNull();
    expect(findOrCreateCrmContact).not.toHaveBeenCalled();
  });
});

describe("findCaptureThread", () => {
  it("never joins another sponsor's thread through a leaked Message-ID (review HIGH)", async () => {
    vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({
      threadId: "t-gsk",
      thread: { counterpartyEmail: "buyer@gsk.com" },
    } as never);
    vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([] as never);
    const id = await findCaptureThread({
      organizationId: "org-1",
      references: ["<leaked@x>"],
      counterpartyEmail: "attacker@evil.example",
      subject: "Bank details",
    });
    expect(id).toBeNull();
  });

  it("joins the thread holding the message it replies to, org-bound", async () => {
    vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({
      threadId: "t-1",
      thread: { counterpartyEmail: "jane@abbott.com" },
    } as never);
    const id = await findCaptureThread({
      organizationId: "org-1",
      references: ["<a@x>"],
      counterpartyEmail: "jane@abbott.com",
      subject: "Re: Sponsorship",
    });
    expect(id).toBe("t-1");
    expect(db.crmEmailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", messageId: { in: ["<a@x>"] } } }),
    );
  });

  it("else the newest thread with the same person on the same subject", async () => {
    vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([
      { id: "t-other", subject: "Invoice" },
      { id: "t-match", subject: "Sponsorship" },
    ] as never);
    const id = await findCaptureThread({
      organizationId: "org-1",
      references: [],
      counterpartyEmail: "Jane@Abbott.com",
      subject: "RE: sponsorship",
    });
    expect(id).toBe("t-match");
    // Only live, recent threads are matched by subject.
    expect(vi.mocked(db.crmEmailThread.findMany).mock.calls[0]![0]!.where).toMatchObject({
      revokedAt: null,
      lastMessageAt: { gte: expect.any(Date) },
    });
  });

  it("else null: a new conversation", async () => {
    vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([] as never);
    expect(
      await findCaptureThread({ organizationId: "org-1", references: [], counterpartyEmail: "x@y.com", subject: "Hi" }),
    ).toBeNull();
  });
});

describe("soleDealForContact", () => {
  it("is the contact's one live deal, else null", async () => {
    vi.mocked(db.crmDealContact.findMany).mockResolvedValue([{ dealId: "d-1" }] as never);
    expect(await soleDealForContact("org-1", "c-1")).toBe("d-1");
    vi.mocked(db.crmDealContact.findMany).mockResolvedValue([{ dealId: "d-1" }, { dealId: "d-2" }] as never);
    expect(await soleDealForContact("org-1", "c-1")).toBeNull();
  });
});

describe("recordCaptureActivity", () => {
  it("writes History on the contact, its account and the deal", () => {
    recordCaptureActivity({
      organizationId: "org-1",
      direction: "INBOUND",
      subject: "Sponsorship",
      counterpartyEmail: "jane@abbott.com",
      contact: { id: "c-1", companyId: "co-1" },
      dealId: "d-1",
      threadId: "t-1",
      unverified: false,
    });
    const targets = vi.mocked(recordCrmActivity).mock.calls.map((c) => `${c[0].entityType}:${c[0].entityId}:${c[0].action}`);
    expect(targets).toEqual(["CONTACT:c-1:EMAIL_RECEIVED", "COMPANY:co-1:EMAIL_RECEIVED", "DEAL:d-1:EMAIL_RECEIVED"]);
    expect(vi.mocked(recordCrmActivity).mock.calls[0]![0].changes).toMatchObject({
      via: "partnerships mailbox",
      from: "jane@abbott.com",
    });
  });
});
