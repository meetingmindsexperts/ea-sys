/**
 * A CRM contact's data on request (CRM product review P1-9, Nov 6, 2026):
 * the export holds everything on the person; the erasure needs their address
 * typed, removes their correspondence (matched by link AND by address) and
 * the attachment files, and leaves one audit row with no name or address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, remove } = vi.hoisted(() => {
  const db = {
    crmContact: { findFirst: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    crmCompany: { findFirst: vi.fn() },
    crmDealContact: { findMany: vi.fn() },
    crmNote: { findMany: vi.fn(), count: vi.fn() },
    crmTask: { findMany: vi.fn(), count: vi.fn() },
    crmEmailThread: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    crmActivity: { findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 2 }), update: vi.fn().mockResolvedValue({}) },
    crmQuote: { findMany: vi.fn(), count: vi.fn() },
    crmEmailMessage: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    crmNotification: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db, remove: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/db", () => ({ db, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/crm/integrations/storage", () => ({ crmStorage: { remove } }));

import { eraseCrmContact, exportCrmContactData, mentionsAddress, scrubMentions } from "@/crm/services/crm-privacy-service";

const ORG = "org-1";
const contact = { id: "c-1", organizationId: ORG, firstName: "Jane", lastName: "Doe", email: "Jane@Abbott.com", emailKey: "jane@abbott.com", companyId: "co-1", archivedAt: null };
const thread = {
  id: "t-1",
  subject: "Sponsorship",
  counterpartyEmail: "jane@abbott.com",
  counterpartyName: "Jane",
  messages: [{ direction: "INBOUND", fromEmail: "jane@abbott.com", fromName: "Jane", subject: "Re", textBody: "Yes", createdAt: new Date("2026-11-01"), attachments: [{ filename: "po.pdf", size: 10, mimeType: "application/pdf", path: "/uploads/crm-email-attachments/t-1/po.pdf" }] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.crmContact.findFirst.mockResolvedValue(contact);
  db.crmCompany.findFirst.mockResolvedValue({ id: "co-1", name: "Abbott" });
  db.crmDealContact.findMany.mockResolvedValue([{ dealId: "d-1", role: "PRIMARY", deal: { id: "d-1", name: "Abbott Gold" } }]);
  db.crmNote.findMany.mockResolvedValue([{ id: "n-1", activityType: "NOTE", body: "Called", createdAt: new Date() }]);
  db.crmNote.count.mockResolvedValue(1);
  db.crmTask.findMany.mockResolvedValue([]);
  db.crmTask.count.mockResolvedValue(0);
  db.crmEmailThread.findMany.mockResolvedValue([thread]);
  db.crmActivity.findMany.mockResolvedValue([]);
  db.crmActivity.count.mockResolvedValue(1);
  db.crmQuote.findMany.mockResolvedValue([{ number: "Q-2026-0001", dealId: "d-1", preparedFor: "Jane Doe", attention: null }]);
  db.crmQuote.count.mockResolvedValue(1);
  // Prefilter hits: one line naming them, one naming a different person whose address CONTAINS theirs.
  db.$queryRaw.mockResolvedValue([
    { id: "a-1", changes: { from: "jane@abbott.com", subject: "Re" } },
    { id: "a-2", changes: { from: "mary-jane@abbott.com" } },
  ]);
  db.crmNotification.findMany.mockResolvedValue([
    { id: "n-1", message: "Jane Doe (jane@abbott.com) replied", link: "/crm/inbox?thread=t-x" },
    { id: "n-2", message: "mary-jane@abbott.com replied", link: "/crm/inbox?thread=t-y" },
    { id: "n-3", message: "Jane Doe wrote to partnerships", link: "/crm/inbox?thread=t-1" },
  ]);
  db.crmEmailMessage.findMany.mockResolvedValue([{ id: "m-elsewhere", attachments: [{ filename: "x.pdf", size: 1, mimeType: "application/pdf", path: "/uploads/crm-email-attachments/t-9/x.pdf" }] }]);
});

// Nov 11, 2026. Prisma compiles { equals, mode: "insensitive" } to ILIKE, where
// "_" is any character, so john_smith@ also matched john.smith@: the export
// handed over another person's conversations and the erasure deleted them.
// Proven on Postgres in tests/integration-db/crm-erasure-wildcard.db.test.ts.
describe("an address with an underscore is matched literally", () => {
  const underscored = { ...contact, id: "c-2", email: "John_Smith@Abbott.com", emailKey: "john_smith@abbott.com" };

  it("the export asks for the escaped address", async () => {
    db.crmContact.findFirst.mockResolvedValue(underscored);
    await exportCrmContactData({ organizationId: ORG, crmContactId: "c-2" });
    expect(db.crmEmailThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, OR: [{ crmContactId: "c-2" }, { counterpartyEmail: { equals: "John\\_Smith@Abbott.com", mode: "insensitive" } }] },
      }),
    );
  });

  it("the erasure asks for the escaped address, for their threads and for their messages elsewhere", async () => {
    db.crmContact.findFirst.mockResolvedValue(underscored);
    await eraseCrmContact({ organizationId: ORG, crmContactId: "c-2", userId: "u-1", confirmEmail: "john_smith@abbott.com", source: "rest" });
    expect(db.crmEmailThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, OR: [{ crmContactId: "c-2" }, { counterpartyEmail: { equals: "John\\_Smith@Abbott.com", mode: "insensitive" } }] },
      }),
    );
    expect(db.crmEmailMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, fromEmail: { equals: "john\\_smith@abbott.com", mode: "insensitive" }, threadId: { notIn: ["t-1"] } },
      }),
    );
  });
});

describe("exportCrmContactData", () => {
  it("collects the contact, deals, notes, the threads with them by link OR address, and their quotes", async () => {
    const res = await exportCrmContactData({ organizationId: ORG, crmContactId: "c-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(db.crmEmailThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, OR: [{ crmContactId: "c-1" }, { counterpartyEmail: { equals: "Jane@Abbott.com", mode: "insensitive" } }] } }),
    );
    expect(res.data.contact).toMatchObject({ firstName: "Jane", email: "Jane@Abbott.com" });
    expect(res.data.contact).not.toHaveProperty("organizationId");
    expect(res.data.deals).toEqual([{ dealId: "d-1", dealName: "Abbott Gold", role: "PRIMARY" }]);
    expect(res.data.emailThreads[0]!.messages[0]!.attachments).toEqual([{ filename: "po.pdf", size: 10, mimeType: "application/pdf" }]);
    expect(res.data.quotesOnTheirDeals).toHaveLength(1);
  });

  it("an unknown or other organisation's contact is not found", async () => {
    db.crmContact.findFirst.mockResolvedValue(null);
    expect(await exportCrmContactData({ organizationId: ORG, crmContactId: "x" })).toMatchObject({ ok: false, code: "CONTACT_NOT_FOUND" });
  });
});

describe("eraseCrmContact", () => {
  const args = { organizationId: ORG, crmContactId: "c-1", userId: "u-1", source: "rest" as const };

  it("refuses without the contact's exact address, erasing nothing", async () => {
    expect(await eraseCrmContact({ ...args, confirmEmail: "someone@else.com" })).toMatchObject({ ok: false, code: "CONFIRMATION_MISMATCH" });
    expect(db.crmContact.deleteMany).not.toHaveBeenCalled();
  });

  it("removes the threads, the contact and its History, then the attachment files; audits counts only", async () => {
    const res = await eraseCrmContact({ ...args, confirmEmail: " jane@abbott.COM " });
    expect(res).toMatchObject({
      ok: true,
      report: {
        erased: { emailThreads: 1, emailMessages: 2, attachmentFiles: 2, notes: 1, dealLinks: 1, historyLines: 2, historyMentions: 1, notifications: 1 },
        remaining: { quotesNamingThem: 1 },
      },
    });
    // Their reply-all on someone else's thread goes too, with its file.
    expect(db.crmEmailMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, fromEmail: { equals: "jane@abbott.com", mode: "insensitive" }, threadId: { notIn: ["t-1"] } } }),
    );
    expect(db.crmEmailMessage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["m-elsewhere"] }, organizationId: ORG } });
    expect(remove).toHaveBeenCalledWith("emailAttachment", "/uploads/crm-email-attachments/t-9/x.pdf");
    // Only the line naming THEIR address is scrubbed; mary-jane's is untouched (review HIGH).
    expect(db.crmActivity.update).toHaveBeenCalledTimes(1);
    expect(db.crmActivity.update).toHaveBeenCalledWith({ where: { id: "a-1" }, data: { changes: { from: "[erased]", subject: "Re" } } });
    // Notifications: their address, or an erased thread; not mary-jane's.
    expect(db.crmNotification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["n-1", "n-3"] }, organizationId: ORG } });
    expect(db.crmEmailThread.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["t-1"] }, organizationId: ORG } });
    expect(db.crmContact.deleteMany).toHaveBeenCalledWith({ where: { id: "c-1", organizationId: ORG } });
    expect(remove).toHaveBeenCalledWith("emailAttachment", "/uploads/crm-email-attachments/t-1/po.pdf");
    const audit = JSON.stringify(db.auditLog.create.mock.calls[0]![0]);
    expect(audit).toContain("CRM_CONTACT_ERASED");
    expect(audit.toLowerCase()).not.toContain("jane");
  });

  it("a file that will not delete is logged, and the erasure still reports success", async () => {
    remove.mockRejectedValueOnce(new Error("s3 down"));
    expect((await eraseCrmContact({ ...args, confirmEmail: "jane@abbott.com" })).ok).toBe(true);
  });
});

describe("exact mentions only", () => {
  it("an address is matched with boundaries, never as a substring", () => {
    expect(mentionsAddress("jane@abbott.com", "jane@abbott.com")).toBe(true);
    expect(mentionsAddress("Jane Doe <Jane@Abbott.com>", "jane@abbott.com")).toBe(true);
    expect(mentionsAddress("mary-jane@abbott.com", "jane@abbott.com")).toBe(false);
    expect(mentionsAddress("jane@abbott.com.au", "jane@abbott.com")).toBe(false);
    expect(mentionsAddress("a_b%c@x.com", "a_b%c@x.com")).toBe(true);
  });

  it("scrubs their address and name on a line that names them, leaving the other people on it", () => {
    const line = { contact: "Jane Doe", email: "jane@abbott.com", others: ["Sam Lee <sam@abbott.com>"] };
    expect(scrubMentions(line, "jane@abbott.com", "Jane Doe")).toEqual({
      changed: true,
      value: { contact: "[erased]", email: "[erased]", others: ["Sam Lee <sam@abbott.com>"] },
    });
  });

  it("never touches a namesake: a line without their address keeps the name", () => {
    expect(scrubMentions({ contact: "Jane Doe", email: "jane.doe@other.com" }, "jane@abbott.com", "Jane Doe")).toMatchObject({ changed: false });
  });
});
