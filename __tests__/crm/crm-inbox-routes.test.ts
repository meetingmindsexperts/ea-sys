/**
 * CRM inbox routes (read-only).
 *
 * Pins: the staff-only boundary (MEMBER passes the generic CRM read gate but
 * must NEVER read sponsor negotiation threads — 403 on every inbox surface,
 * using the REAL canViewCrmInbox predicate), org-bound lookups, and the
 * shared-inbox unread-clear on open. The inbox is READ-ONLY — sending is
 * centralized on the deal's Email action, so there is no reply-from-inbox route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmEmailThread: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    crmEmailMessage: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const fsMock = vi.hoisted(() => ({ realpath: vi.fn(), readFile: vi.fn() }));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

// Gates pass-through with a configurable role — canViewCrmInbox stays REAL.
// Full module mock (importOriginal would drag next-auth into vitest via
// getOrgContext); the gates themselves are pinned by the gate-drift test.
const gate = vi.hoisted(() => ({ role: "ADMIN", fromApiKey: false }));
vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  requireCrmWrite: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  crmErrorResponse: vi.fn(() => new Response(null, { status: 500 })),
}));

import { db } from "@/lib/db";
import { GET as listThreads } from "@/app/api/crm/inbox/route";
import { GET as getThread } from "@/app/api/crm/inbox/[threadId]/route";
import { GET as getAttachment } from "@/app/api/crm/inbox/messages/[messageId]/attachments/[index]/route";

const threadDetail = {
  id: "t-1",
  subject: "Sponsorship",
  replyToken: "abcdef0123456789abcd",
  counterpartyEmail: "jane@abbott.com",
  counterpartyName: "Jane Doe",
  hasUnread: true,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  deal: { id: "d-1", name: "Abbott deal" },
  crmContact: null,
  messages: [],
};

const threadParams = Promise.resolve({ threadId: "t-1" });
const attParams = Promise.resolve({ messageId: "m-1", index: "0" });

beforeEach(() => {
  vi.clearAllMocks();
  gate.role = "ADMIN";
  gate.fromApiKey = false;
  vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([] as never);
  vi.mocked(db.crmEmailThread.count).mockResolvedValue(0 as never);
  vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue(threadDetail as never);
  vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({
    attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", path: "/uploads/crm-email-attachments/t-1/abc.pdf" }],
  } as never);
  fsMock.realpath.mockImplementation(async (p: string) => p);
  fsMock.readFile.mockResolvedValue(Buffer.from("%PDF-1.7"));
});

describe("staff-only boundary (real canViewCrmInbox)", () => {
  it("MEMBER is 403 on the list, the thread AND an attachment — never reads rival negotiations", async () => {
    gate.role = "MEMBER";
    expect((await listThreads(new Request("http://test/api/crm/inbox"))).status).toBe(403);
    expect((await getThread(new Request("http://test"), { params: threadParams })).status).toBe(403);
    expect((await getAttachment(new Request("http://test"), { params: attParams })).status).toBe(403);
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.findFirst).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("CRM_USER reads the shared inbox (owner decision: one bulk inbox for staff)", async () => {
    gate.role = "CRM_USER";
    expect((await listThreads(new Request("http://test/api/crm/inbox"))).status).toBe(200);
  });
});

describe("thread detail", () => {
  it("is org-bound and clears the unread flag on open (shared-inbox semantics)", async () => {
    const res = await getThread(new Request("http://test"), { params: threadParams });
    expect(res.status).toBe(200);
    expect(db.crmEmailThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1", organizationId: "org-1" } }),
    );
    expect(db.crmEmailThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1", organizationId: "org-1", hasUnread: true },
        data: { hasUnread: false },
      }),
    );
  });

  it("an already-read thread costs no write", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue({ ...threadDetail, hasUnread: false } as never);
    await getThread(new Request("http://test"), { params: threadParams });
    expect(db.crmEmailThread.updateMany).not.toHaveBeenCalled();
  });
});
